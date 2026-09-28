# Third-party notices

This image redistributes the unmodified upstream OpenFang release binary.

- OpenFang — https://github.com/RightNow-AI/openfang
  Version: 0.6.9 (release tag `v0.6.9`, commit `acf2587e46be174c10200489c9a2d23a39a98aeb`)
  License: Apache-2.0 OR MIT (https://github.com/RightNow-AI/openfang/blob/v0.6.9/LICENSE-APACHE,
  https://github.com/RightNow-AI/openfang/blob/v0.6.9/LICENSE-MIT)
  Asset: `openfang-x86_64-unknown-linux-gnu.tar.gz`,
  SHA-256 `4309b0bcf2adc5dac45776e2008087a8ad072933f1ae698ff8d4e06fb6b87602`

The gate (everything under `gate/`) is original work licensed under MIT (see `LICENSE`)
and has no runtime npm dependencies. The base image is Debian 12 (`node:22-bookworm-slim`);
Debian package licenses are available in `/usr/share/doc/*/copyright` inside the image.

This project is not affiliated with, endorsed by, or an official distribution of
OpenFang / RightNow AI, or of Railway.
