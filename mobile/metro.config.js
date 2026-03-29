const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// Watch the monorepo root and packages/
config.watchFolders = [workspaceRoot];

// Let Metro resolve packages from the workspace root node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Enable package.json exports field (required for @radio/shared)
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
