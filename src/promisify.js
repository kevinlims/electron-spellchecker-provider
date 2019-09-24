import pify from 'pify';

module.exports = ['fs'].reduce((acc, x) => {
  acc[x] = pify(require(x));
  return acc;
}, {});
