# Vendored Third-Party Libraries

This add-on uses the following unmodified third-party libraries:

## pdf-lib
- **Version**: 1.17.1
- **Source URL**: https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js
- **License**: MIT License (https://github.com/Hopding/pdf-lib/blob/master/LICENSE)
- **Purpose**: Used for PDF document generation and merging.

## JSZip
- **Version**: 3.10.1
- **Source URL**: https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
- **License**: MIT License (https://github.com/Stuk/jszip/blob/main/LICENSE.markdown)
- **Purpose**: Used for reading and extracting ZIP archive contents.

## decrypt-pdf.js (v1.1, original code — not vendored)
- **Purpose**: Decrypts standard-encrypted PDFs (RC4-40bit, V=1 / R=2, empty
  password) before merging, so bank statements and similar encrypted PDFs
  do not come out as blank pages. Pure JavaScript implementation of MD5
  (RFC 1321) and RC4 plus the standard PDF decryption algorithm (PDF spec
  §3.5). No third-party library, no browser APIs.
- **Scope**: Only `/Filter /Standard`, `/V 1`, `/R 2`, 40-bit keys with an
  empty password. AES, V=2+, R=3+, and password-protected PDFs are detected
  and skipped with a user notification instead of being merged blank.