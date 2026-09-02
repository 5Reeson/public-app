# VX plugin distribution contract

The optional plugin is distributed as a ZIP containing exactly three files at its root:

- `manifest.json`
- the helper named by the manifest
- the interposer named by the manifest

The provider-independent `index.json` points to immutable, versioned ZIP objects and includes the plugin API version, supported architectures, size and SHA-256. Package URLs may be relative to the index URL, so the same contract works with R2 or another HTTPS object store.

The application downloads into a temporary directory, verifies the distribution metadata and archive, validates the embedded manifest and native artifacts, and atomically activates the plugin. Failed activation preserves the previous installed version.

This public repository implements that installer contract but does not build or contain the native plugin. Official plugin packaging is maintained in the private release repository.
