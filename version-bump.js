#!/usr/bin/env node
// `npm version <x.y.z>`: the new version into manifest.json and versions.json (with the minimum Obsidian version).
'use strict';
const fs = require('fs');
const version = process.env.npm_package_version;
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
manifest.version = version;
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));
versions[version] = manifest.minAppVersion;
fs.writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');
