const path = require("path");
const { transform } = require("@svgr/core");
const babel = require("@babel/core");

function toComponentName(resourcePath) {
  const baseName = path.basename(resourcePath, path.extname(resourcePath));
  const safeName = baseName.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  const pascal = safeName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  return `Svg${pascal || "Asset"}`;
}

function buildFallbackModule(componentName, svgSource = "") {
  return [
    'import * as React from "react";',
    `const ${componentName} = React.forwardRef(function ${componentName}(_props, _ref) {`,
    "  return null;",
    "});",
    `${componentName}.displayName = ${JSON.stringify(componentName)};`,
    `export { ${componentName} as ReactComponent };`,
    `export default ${JSON.stringify(svgSource)};`,
    "",
  ].join("\n");
}

async function compileSvgModule(svgSource, resourcePath, options) {
  const componentName = toComponentName(resourcePath);
  const jsxCode = await transform(
    svgSource,
    {
      ref: true,
      exportType: "named",
      namedExport: "ReactComponent",
      svgo: false,
      ...options,
      plugins: ["@svgr/plugin-jsx"],
    },
    { componentName },
  );

  const transformed = await babel.transformAsync(jsxCode, {
    filename: resourcePath,
    babelrc: false,
    configFile: false,
    sourceMaps: false,
    presets: [[require.resolve("@babel/preset-react"), { runtime: "classic" }]],
  });

  return `${transformed?.code ?? jsxCode}\nexport default ${JSON.stringify(svgSource)};\n`;
}

function getShortErrorMessage(error) {
  const message = error?.message ? String(error.message) : "Unknown SVG transform error";

  return message.split("\n")[0];
}

module.exports = function safeSvgrLoader(src) {
  this.cacheable?.();

  const callback = this.async();
  const resourcePath = this.resourcePath || "unknown.svg";
  const options = this.getOptions?.() ?? {};
  const svgSource = typeof src === "string" ? src : src ? String(src) : "";
  const componentName = toComponentName(resourcePath);

  if (!svgSource.trim()) {
    this.emitWarning(new Error(`[safe-svgr-loader] Empty SVG content for ${resourcePath}; using empty fallback component.`));
    callback(null, buildFallbackModule(componentName));
    return;
  }

  compileSvgModule(svgSource, resourcePath, options)
    .then((code) => callback(null, code))
    .catch((error) => {
      this.emitWarning(
        new Error(
          `[safe-svgr-loader] Failed to transform ${resourcePath}; using empty fallback component instead. ${getShortErrorMessage(error)}`,
        ),
      );
      callback(null, buildFallbackModule(componentName));
    });
};