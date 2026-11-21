// Settings for Mozilla's web-ext tool (npm run lint:firefox / start:firefox / build).
// Only the extension's own files go into the package uploaded to the stores.
export default {
  ignoreFiles: [
    "docs",
    "tests",
    ".github",
    "node_modules",
    "web-ext-artifacts",
    "package.json",
    "package-lock.json",
    "web-ext-config.mjs",
    "CONTRIBUTING.md",
    "SECURITY.md",
  ],
  build: { overwriteDest: true },
};
