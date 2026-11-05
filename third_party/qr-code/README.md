# Local QR encoder

- Package: qrcode-generator 2.0.4 by Kazuhiko Arase (MIT).
- Official source: https://github.com/kazuhikoarase/qrcode-generator/tree/js2.0.4
- npm release: https://www.npmjs.com/package/qrcode-generator/v/2.0.4
- Preserved source: ../../dist/vendor/qrcode-generator-2.0.4.js
- Full license: ../../dist/vendor/qrcode-generator-LICENSE.txt
- Source SHA-256: 79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c
- Registry tarball integrity: sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==

The scoped dist/vendor/.gitattributes keeps Git from changing the vendored line endings. The source file is copied byte for byte from the integrity-checked official npm tarball. It is loaded locally before share-client.js. No remote QR-generation API receives share URLs.

share-client.js renders the actual encoded matrix as SVG with four quiet modules, a light mint background (#e2eadf) and dark modules (#102024). It contains no generated placeholder QR or embedded private data beyond the explicitly created image link.

A local smoke check rasterized the production drawQR SVG path in the same mint/dark colors at six pixels per module and decoded the exact synthetic share URL with jsqr 1.4.0. The decoder and generated fixtures remain in ignored development files, not the shipped site.
