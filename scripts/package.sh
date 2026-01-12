#!/bin/bash

# Exit on error
set -e

# 1. Run clean-cache
echo "🧹 Cleaning old packages..."
yarn run clean-cache

# 2. Bump version (Minor version +1)
# Fetch current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "📦 Current version: $CURRENT_VERSION"

# Split version by dots
IFS='.' read -ra ADDR <<< "$CURRENT_VERSION"
MAJOR=${ADDR[0]}
MINOR=${ADDR[1]}
PATCH=${ADDR[2]}

# Increment minor version
NEW_MINOR=$((MINOR + 1))
NEW_VERSION="$MAJOR.$NEW_MINOR.0"

echo "🚀 Bumping version to: $NEW_VERSION"

# Update package.json using node to ensure correct JSON formatting
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# 3. Build/Package
echo "🛠️  Packaging extension..."
vsce package --no-git-tag-version --allow-missing-repository -o dist/

echo "✅ Done! New package created: dist/vs-code-extension-tree-note-$NEW_VERSION.vsix"
