const esbuild = require("esbuild");
const { dependencies } = require("./package.json");

const commonConfig = {
    entryPoints: {
        index: "./src/index.ts",
        cdk: "./src/cdk.ts",
    },
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
    outdir: "./dist",
    entryNames: "[name].cjs"
});

esbuild.buildSync({
    ...commonConfig,
    format: "esm",
    outdir: "./dist",
    entryNames: "[name].esm"
});