// CircuitSolver.ts
// Modified Nodal Analysis (MNA) DC solver. Pure math, no Lens Studio deps.
// Supports: resistor, LED (Vf + series R), voltage source, wire, capacitor (open for DC).
//
// Usage:
//   const solver = new CircuitSolver();
//   solver.addResistor('n1', 'n2', 220);
//   solver.addLED('n2', 'n3', 1.8, 10);
//   solver.addVoltageSource('n1', 'gnd', 3.3);
//   const result = solver.solve();
//   // result.nodeVoltages.get('n1') => 3.3
//   // result.branchCurrents.get(0) => ~0.0068

export interface SolverResult {
    nodeVoltages: Map<string, number>;
    branchCurrents: Map<number, number>;
    branchPower: Map<number, number>;
    valid: boolean;
    error?: string;
}

interface Element {
    type: 'resistor' | 'voltageSource' | 'wire';
    nPlus: string;
    nMinus: string;
    value: number; // ohms for R, volts for V
    id: number;
}

const GND = 'gnd';

export class CircuitSolver {
    private elements: Element[] = [];
    private nextId: number = 0;

    clear(): void {
        this.elements = [];
        this.nextId = 0;
    }

    addResistor(nPlus: string, nMinus: string, ohms: number): number {
        const id = this.nextId++;
        this.elements.push({ type: 'resistor', nPlus, nMinus, value: Math.max(ohms, 0.001), id });
        return id;
    }

    addWire(nPlus: string, nMinus: string): number {
        return this.addResistor(nPlus, nMinus, 0.001);
    }

    addVoltageSource(nPlus: string, nMinus: string, volts: number): number {
        const id = this.nextId++;
        this.elements.push({ type: 'voltageSource', nPlus, nMinus, value: volts, id });
        return id;
    }

    // LED modeled as Vf voltage source + series resistance
    addLED(nAnode: string, nCathode: string, vForward: number = 1.8, seriesR: number = 10): number {
        // Internal node between Vf source and series R
        const internal = `__led_${this.nextId}`;
        this.addVoltageSource(nAnode, internal, vForward);
        return this.addResistor(internal, nCathode, seriesR);
    }

    // Capacitor: open circuit for DC (just skip it)
    addCapacitor(_nPlus: string, _nMinus: string, _farads: number): number {
        return this.nextId++; // no-op for DC
    }

    solve(): SolverResult {
        const empty: SolverResult = {
            nodeVoltages: new Map(), branchCurrents: new Map(),
            branchPower: new Map(), valid: false
        };

        // Collect all non-ground nodes
        const nodeSet = new Set<string>();
        for (const el of this.elements) {
            if (el.nPlus !== GND) nodeSet.add(el.nPlus);
            if (el.nMinus !== GND) nodeSet.add(el.nMinus);
        }
        const nodes = Array.from(nodeSet);
        const nodeIdx = new Map<string, number>();
        for (let i = 0; i < nodes.length; i++) nodeIdx.set(nodes[i], i);

        // Count voltage sources for augmented rows
        const vSources = this.elements.filter(e => e.type === 'voltageSource');
        const n = nodes.length;
        const m = vSources.length;
        const size = n + m;

        if (size === 0) {
            empty.valid = true;
            return empty;
        }

        // Build MNA matrix A and vector b
        const A = this.zeros(size, size);
        const b = new Array(size).fill(0);

        // Stamp resistors into conductance matrix
        for (const el of this.elements) {
            if (el.type !== 'resistor') continue;
            const g = 1.0 / el.value;
            const ni = el.nPlus !== GND ? nodeIdx.get(el.nPlus)! : -1;
            const nj = el.nMinus !== GND ? nodeIdx.get(el.nMinus)! : -1;
            if (ni >= 0) A[ni][ni] += g;
            if (nj >= 0) A[nj][nj] += g;
            if (ni >= 0 && nj >= 0) {
                A[ni][nj] -= g;
                A[nj][ni] -= g;
            }
        }

        // Stamp voltage sources (augmented rows/cols)
        for (let vi = 0; vi < vSources.length; vi++) {
            const vs = vSources[vi];
            const row = n + vi;
            const ni = vs.nPlus !== GND ? nodeIdx.get(vs.nPlus)! : -1;
            const nj = vs.nMinus !== GND ? nodeIdx.get(vs.nMinus)! : -1;

            if (ni >= 0) { A[ni][row] += 1; A[row][ni] += 1; }
            if (nj >= 0) { A[nj][row] -= 1; A[row][nj] -= 1; }
            b[row] = vs.value;
        }

        // Solve Ax = b via Gaussian elimination with partial pivoting
        const x = this.gaussianSolve(A, b, size);
        if (!x) {
            empty.error = 'Singular matrix';
            return empty;
        }

        // Extract results
        const nodeVoltages = new Map<string, number>();
        nodeVoltages.set(GND, 0);
        for (let i = 0; i < n; i++) {
            nodeVoltages.set(nodes[i], x[i]);
        }

        const branchCurrents = new Map<number, number>();
        const branchPower = new Map<number, number>();

        // Voltage source currents from augmented variables
        for (let vi = 0; vi < vSources.length; vi++) {
            const vs = vSources[vi];
            branchCurrents.set(vs.id, x[n + vi]);
            branchPower.set(vs.id, Math.abs(vs.value * x[n + vi]));
        }

        // Resistor currents from V = IR
        for (const el of this.elements) {
            if (el.type !== 'resistor') continue;
            const vPlus = nodeVoltages.get(el.nPlus) || 0;
            const vMinus = nodeVoltages.get(el.nMinus) || 0;
            const current = (vPlus - vMinus) / el.value;
            branchCurrents.set(el.id, current);
            branchPower.set(el.id, current * current * el.value);
        }

        return { nodeVoltages, branchCurrents, branchPower, valid: true };
    }

    private zeros(rows: number, cols: number): number[][] {
        const m: number[][] = [];
        for (let i = 0; i < rows; i++) {
            m.push(new Array(cols).fill(0));
        }
        return m;
    }

    private gaussianSolve(A: number[][], b: number[], n: number): number[] | null {
        // Augment matrix
        const aug: number[][] = [];
        for (let i = 0; i < n; i++) {
            aug.push([...A[i], b[i]]);
        }

        // Forward elimination with partial pivoting
        for (let col = 0; col < n; col++) {
            // Find pivot
            let maxVal = Math.abs(aug[col][col]);
            let maxRow = col;
            for (let row = col + 1; row < n; row++) {
                const v = Math.abs(aug[row][col]);
                if (v > maxVal) { maxVal = v; maxRow = row; }
            }

            if (maxVal < 1e-12) return null; // singular

            // Swap rows
            if (maxRow !== col) {
                const tmp = aug[col];
                aug[col] = aug[maxRow];
                aug[maxRow] = tmp;
            }

            // Eliminate below
            const pivot = aug[col][col];
            for (let row = col + 1; row < n; row++) {
                const factor = aug[row][col] / pivot;
                for (let j = col; j <= n; j++) {
                    aug[row][j] -= factor * aug[col][j];
                }
            }
        }

        // Back substitution
        const x = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            let sum = aug[i][n];
            for (let j = i + 1; j < n; j++) {
                sum -= aug[i][j] * x[j];
            }
            x[i] = sum / aug[i][i];
        }

        return x;
    }
}
