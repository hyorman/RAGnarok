import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// These pure-JavaScript dependencies are imported by bundled @ragnarok/core
// code. Keep them in the extension bundle so the root entry point does not
// depend on workspace-specific node_modules placement in a staged VSIX.
const bundledGraphDependencies = [
  "graphology",
  "graphology-communities-louvain",
  "graphology-indices",
  "graphology-utils",
  "mnemonist",
  "obliterator",
  "pandemonium",
];

/** @type {import('esbuild').Plugin} */
const externalizeNonWorkspaceDeps = {
  name: "externalize-non-workspace-deps",
  setup(build) {
    // Externalize all bare-specifier imports except @ragnarok/* workspace packages
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (
        args.path.startsWith("@ragnarok/") ||
        bundledGraphDependencies.some(
          (dependency) => args.path === dependency || args.path.startsWith(`${dependency}/`),
        )
      ) {
        return undefined; // Let esbuild resolve and bundle these dependencies.
      }
      return { path: args.path, external: true };
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["packages/vscode/dist/extension.js"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  plugins: [externalizeNonWorkspaceDeps],
});

if (watch) {
  await ctx.watch();
  console.log("[esbuild] watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("[esbuild] bundle complete: dist/extension.js");
}
