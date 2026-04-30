// MatrixMath.ts
// Small linear-algebra primitives for the plane-from-motion tracking pipeline.
// Self-contained — no Lens Studio types — so this file can also be unit-tested
// in plain Node. Matrices are stored as flat row-major Float64Array's; row r,
// col c is at index r * cols + c.
//
// Routines:
//   matMul, matT, matInv3
//   solveLinear   — Gauss elimination with partial pivoting (NxN)
//   nearestRotation3 — polar decomposition for closest SO(3) to a 3x3 matrix
//   det3, eig3sym   — 3x3 determinant and symmetric eigendecomposition
//
// All functions allocate fresh output arrays so they're easy to compose.
// Hot loops in PlaneTracker.ts that need to avoid GC should reuse buffers
// outside this module.

export type Mat = Float64Array;

export function makeMat(rows: number, cols: number, fill: number = 0): Mat {
    var m = new Float64Array(rows * cols);
    if (fill !== 0) {
        for (var i = 0; i < m.length; i++) m[i] = fill;
    }
    return m;
}

export function eye(n: number): Mat {
    var m = makeMat(n, n);
    for (var i = 0; i < n; i++) m[i * n + i] = 1;
    return m;
}

export function matMul(A: Mat, ar: number, ac: number,
                       B: Mat, br: number, bc: number): Mat {
    if (ac !== br) throw new Error("matMul: dim mismatch");
    var C = new Float64Array(ar * bc);
    for (var i = 0; i < ar; i++) {
        for (var k = 0; k < ac; k++) {
            var aik = A[i * ac + k];
            if (aik === 0) continue;
            for (var j = 0; j < bc; j++) {
                C[i * bc + j] += aik * B[k * bc + j];
            }
        }
    }
    return C;
}

export function matT(A: Mat, rows: number, cols: number): Mat {
    var T = new Float64Array(rows * cols);
    for (var i = 0; i < rows; i++) {
        for (var j = 0; j < cols; j++) {
            T[j * rows + i] = A[i * cols + j];
        }
    }
    return T;
}

export function det3(M: Mat): number {
    // Standard 3x3 cofactor expansion.
    return (
        M[0] * (M[4] * M[8] - M[5] * M[7]) -
        M[1] * (M[3] * M[8] - M[5] * M[6]) +
        M[2] * (M[3] * M[7] - M[4] * M[6])
    );
}

export function matInv3(M: Mat): Mat {
    var d = det3(M);
    if (Math.abs(d) < 1e-12) throw new Error("matInv3: singular");
    var inv = new Float64Array(9);
    var id = 1.0 / d;
    inv[0] =  (M[4] * M[8] - M[5] * M[7]) * id;
    inv[1] = -(M[1] * M[8] - M[2] * M[7]) * id;
    inv[2] =  (M[1] * M[5] - M[2] * M[4]) * id;
    inv[3] = -(M[3] * M[8] - M[5] * M[6]) * id;
    inv[4] =  (M[0] * M[8] - M[2] * M[6]) * id;
    inv[5] = -(M[0] * M[5] - M[2] * M[3]) * id;
    inv[6] =  (M[3] * M[7] - M[4] * M[6]) * id;
    inv[7] = -(M[0] * M[7] - M[1] * M[6]) * id;
    inv[8] =  (M[0] * M[4] - M[1] * M[3]) * id;
    return inv;
}

// Gauss elimination with partial pivoting. Solves A · x = b for square A.
// Mutates A and b; returns x as a new array. Throws on singular.
export function solveLinear(A: Mat, b: Float64Array, n: number): Float64Array {
    // Build augmented matrix [A | b] in a single buffer.
    var M = new Float64Array(n * (n + 1));
    for (var i = 0; i < n; i++) {
        for (var j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j];
        M[i * (n + 1) + n] = b[i];
    }

    // Forward elimination.
    for (var col = 0; col < n; col++) {
        // Find pivot row.
        var maxRow = col;
        var maxVal = Math.abs(M[col * (n + 1) + col]);
        for (var r = col + 1; r < n; r++) {
            var v = Math.abs(M[r * (n + 1) + col]);
            if (v > maxVal) { maxVal = v; maxRow = r; }
        }
        if (maxVal < 1e-12) throw new Error("solveLinear: singular");
        if (maxRow !== col) {
            for (var c = col; c <= n; c++) {
                var tmp = M[col * (n + 1) + c];
                M[col * (n + 1) + c] = M[maxRow * (n + 1) + c];
                M[maxRow * (n + 1) + c] = tmp;
            }
        }
        // Eliminate below.
        for (var r2 = col + 1; r2 < n; r2++) {
            var f = M[r2 * (n + 1) + col] / M[col * (n + 1) + col];
            for (var c2 = col; c2 <= n; c2++) {
                M[r2 * (n + 1) + c2] -= f * M[col * (n + 1) + c2];
            }
        }
    }

    // Back substitution.
    var x = new Float64Array(n);
    for (var i2 = n - 1; i2 >= 0; i2--) {
        var s = M[i2 * (n + 1) + n];
        for (var j2 = i2 + 1; j2 < n; j2++) {
            s -= M[i2 * (n + 1) + j2] * x[j2];
        }
        x[i2] = s / M[i2 * (n + 1) + i2];
    }
    return x;
}

// Closed-form symmetric 3x3 eigendecomposition (Smith 1961 / Deledalle 2017).
// Returns { eigenvalues: [λ1, λ2, λ3] sorted descending,
//           eigenvectors: 3x3 matrix with columns = corresponding eigenvectors }.
// M must be symmetric (M = M^T).
export function eig3sym(M: Mat): { values: Float64Array; vectors: Mat } {
    var p1 = M[1] * M[1] + M[2] * M[2] + M[5] * M[5];
    var values = new Float64Array(3);
    var vectors = new Float64Array(9);

    if (p1 < 1e-20) {
        // Already diagonal.
        values[0] = M[0]; values[1] = M[4]; values[2] = M[8];
        vectors[0] = 1; vectors[4] = 1; vectors[8] = 1;
    } else {
        var q = (M[0] + M[4] + M[8]) / 3.0;
        var p2 = (M[0] - q) * (M[0] - q) + (M[4] - q) * (M[4] - q) +
                 (M[8] - q) * (M[8] - q) + 2 * p1;
        var p = Math.sqrt(p2 / 6.0);
        // B = (1/p) * (M - q*I)
        var B = new Float64Array(9);
        var ip = 1.0 / p;
        B[0] = (M[0] - q) * ip; B[1] = M[1] * ip;       B[2] = M[2] * ip;
        B[3] = M[3] * ip;       B[4] = (M[4] - q) * ip; B[5] = M[5] * ip;
        B[6] = M[6] * ip;       B[7] = M[7] * ip;       B[8] = (M[8] - q) * ip;
        var r = det3(B) / 2.0;
        if (r < -1) r = -1;
        else if (r > 1) r = 1;
        var phi = Math.acos(r) / 3.0;
        values[0] = q + 2 * p * Math.cos(phi);
        values[2] = q + 2 * p * Math.cos(phi + (2 * Math.PI / 3));
        values[1] = 3 * q - values[0] - values[2];
    }

    // Sort eigenvalues descending and compute eigenvectors via cross-product
    // method (works when eigenvalues are distinct; degenerate case is rare
    // for our use cases — homography decompositions).
    if (values[1] > values[0]) { var t = values[0]; values[0] = values[1]; values[1] = t; }
    if (values[2] > values[0]) { var t2 = values[0]; values[0] = values[2]; values[2] = t2; }
    if (values[2] > values[1]) { var t3 = values[1]; values[1] = values[2]; values[2] = t3; }

    for (var k = 0; k < 3; k++) {
        var lam = values[k];
        // (M - λI) has rank ≤ 2; the eigenvector lies in its null space.
        // The cross product of any two linearly INDEPENDENT columns gives a
        // vector orthogonal to both, which is the null direction. But two
        // nearly-parallel columns produce a cross product dominated by
        // floating-point cancellation noise — this is exactly what happens
        // when the matrix has a zero row/column (planar Kabsch case), where
        // the third column is (0, 0, ±λ) and the first two are linearly
        // dependent in the xy plane.
        //
        // Robust strategy: try ALL THREE column pairs and pick the one with
        // the largest cross-product magnitude. That guarantees we use the
        // best-conditioned independent pair available.
        var c0x = M[0] - lam, c0y = M[3],       c0z = M[6];
        var c1x = M[1],       c1y = M[4] - lam, c1z = M[7];
        var c2x = M[2],       c2y = M[5],       c2z = M[8] - lam;

        var e01x = c0y * c1z - c0z * c1y;
        var e01y = c0z * c1x - c0x * c1z;
        var e01z = c0x * c1y - c0y * c1x;
        var n01 = e01x * e01x + e01y * e01y + e01z * e01z;

        var e02x = c0y * c2z - c0z * c2y;
        var e02y = c0z * c2x - c0x * c2z;
        var e02z = c0x * c2y - c0y * c2x;
        var n02 = e02x * e02x + e02y * e02y + e02z * e02z;

        var e12x = c1y * c2z - c1z * c2y;
        var e12y = c1z * c2x - c1x * c2z;
        var e12z = c1x * c2y - c1y * c2x;
        var n12 = e12x * e12x + e12y * e12y + e12z * e12z;

        var ex = 0, ey = 0, ez = 0, nbest = 0;
        if (n01 >= n02 && n01 >= n12) {
            ex = e01x; ey = e01y; ez = e01z; nbest = n01;
        } else if (n02 >= n12) {
            ex = e02x; ey = e02y; ez = e02z; nbest = n02;
        } else {
            ex = e12x; ey = e12y; ez = e12z; nbest = n12;
        }
        var n = Math.sqrt(nbest);
        if (n < 1e-12) {
            // True triple-degeneracy (all three columns parallel) — fall back
            // to a basis vector. Caller is responsible for re-orthonormalising
            // against earlier vectors if this matters.
            ex = (k === 0) ? 1 : 0;
            ey = (k === 1) ? 1 : 0;
            ez = (k === 2) ? 1 : 0;
            n = 1;
        }
        vectors[0 * 3 + k] = ex / n;
        vectors[1 * 3 + k] = ey / n;
        vectors[2 * 3 + k] = ez / n;
    }

    return { values: values, vectors: vectors };
}

// Project a 3x3 matrix to its nearest rotation matrix in SO(3) via polar
// decomposition: R = M · (M^T · M)^(-1/2). The matrix square root is
// computed via the symmetric eigendecomposition of M^T·M. Forces det(R) = +1
// by flipping the sign of the smallest eigenvector if needed.
export function nearestRotation3(M: Mat): Mat {
    // S = M^T · M
    var S = new Float64Array(9);
    for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
            var s = 0;
            for (var k = 0; k < 3; k++) {
                s += M[k * 3 + i] * M[k * 3 + j];
            }
            S[i * 3 + j] = s;
        }
    }
    var eig = eig3sym(S);
    // S^(-1/2) = V · diag(1/sqrt(λ)) · V^T
    var sqInvD = new Float64Array(3);
    for (var d = 0; d < 3; d++) {
        var lam = eig.values[d];
        if (lam < 1e-12) lam = 1e-12;
        sqInvD[d] = 1.0 / Math.sqrt(lam);
    }
    var Vd = new Float64Array(9);
    for (var r = 0; r < 3; r++) {
        for (var c = 0; c < 3; c++) {
            Vd[r * 3 + c] = eig.vectors[r * 3 + c] * sqInvD[c];
        }
    }
    var Vt = matT(eig.vectors, 3, 3);
    var Sinvhalf = matMul(Vd, 3, 3, Vt, 3, 3);
    var R = matMul(M, 3, 3, Sinvhalf, 3, 3);
    // Force det = +1 (handle reflections).
    if (det3(R) < 0) {
        // Flip the column of V corresponding to the smallest eigenvalue, then redo.
        // Equivalent: negate one row of R. The simplest is to negate the row tied
        // to the smallest singular value, but for our use case (homography
        // decomposition) this just means flipping R's sign on the third column.
        for (var ii = 0; ii < 3; ii++) {
            R[ii * 3 + 2] = -R[ii * 3 + 2];
        }
    }
    return R;
}
