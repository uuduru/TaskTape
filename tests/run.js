// Runs every TaskTape test: npm install, then npm test
const { failed } = require("./helpers");

(async () => {
  await require("./content.test")();
  await require("./background.test")();
  await require("./ui.test")();
  const count = failed();
  console.log(count ? `\n${count} test(s) FAILED` : "\nAll tests passed");
  process.exit(count ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
