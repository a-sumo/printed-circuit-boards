// Auto-generated board catalog
module.exports.boards = [
  {
    "name": "Arduino Nano",
    "slug": "arduino-nano"
  },
  {
    "name": "StickHub USB",
    "slug": "stickhub-usb"
  }
];
module.exports.load = function(slug) {
  return require("./" + slug + ".js");
};
