export function assertDevOnlyDependency(packageManifest, dependency, expectedDevelopmentVersion) {
  for (const surface of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    const declaration = packageManifest?.[surface];
    const containsDependency = Array.isArray(declaration)
      ? declaration.includes(dependency)
      : declaration !== null && typeof declaration === "object" && Object.hasOwn(declaration, dependency);
    if (containsDependency) {
      throw new Error(`${dependency} must be absent from ${surface}`);
    }
  }
  const developmentVersion = packageManifest?.devDependencies?.[dependency];
  if (
    typeof expectedDevelopmentVersion !== "string" ||
    expectedDevelopmentVersion.trim() === "" ||
    developmentVersion !== expectedDevelopmentVersion
  ) {
    throw new Error(`${dependency} must have exact development dependency ${expectedDevelopmentVersion}`);
  }
}
