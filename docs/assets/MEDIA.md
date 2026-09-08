# Pi gallery media placeholders

Add these files before release:

- `demo.mp4`: short Pi gallery demo video. MP4 is required.
- `gallery-preview.png`: static gallery fallback image.

Update `pi.video` and `pi.image` in `package.json` to public HTTPS URLs containing the final GitHub owner. The release metadata check blocks npm publication while the owner placeholder remains.
