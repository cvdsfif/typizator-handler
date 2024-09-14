const esbuild = require("esbuild");
const { dependencies } = require("./package.json");

const commonConfig = {
    entryPoints: ["./src/index.ts"],
    target: ["esnext", "node20"],
    bundle: true,
    minify: true,
    treeShaking: true,
    platform: "node",
    external: [...Object.keys(dependencies), "aws-cdk-lib", "constructs"]
}

esbuild.buildSync({
    ...commonConfig,
    format: "cjs",
    outfile: "./dist/index.cjs.js"
});

esbuild.buildSync({
    ...commonConfig,
    format: "esm",
    outfile: "./dist/index.esm.js"
});