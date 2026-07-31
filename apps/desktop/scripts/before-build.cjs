const { prepareOpenSpecRuntime } = require('./prepare-openspec-runtime.cjs');

module.exports = async function beforeBuild() {
  await prepareOpenSpecRuntime();
  return false;
};
