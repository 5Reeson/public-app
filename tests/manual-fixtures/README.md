# Manual import fixtures

`broken-image.webp` is intentionally not an image. Import it together with valid images to verify
that the app reports one failure while keeping the successful imports.

Renaming a real image to `.txt` is not a corruption test: the app detects images by decoded file
content rather than trusting the filename extension.
