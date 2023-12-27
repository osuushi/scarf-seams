# scarf-seams

## Warning
This is an experimental tool in a pre-release state. Post-processing gcode
is complicated, and bugs could cause your printer to try to move your
nozzle out of bounds (including crashing into the print bed). The code
attempts to protect against these cases, but there is no substitute for
examining the output gcode in a gcode previewer before printing. **Use
at your own risk.**

## Purpose

There has been some experimentation recently with hiding seems with 3D printing. [This
repo](https://github.com/vgdh/seam-hiding-whitepaper) and [this PrusaSlicer pull
request](https://github.com/prusa3d/PrusaSlicer/issues/11621) discuss the technique, and
provide examples using custom generated gcode. However, these examples only allow creating
a cylinder.

This tool will allow you to load an arbitrary gcode file and apply the technique to it.

If you just want to use the tool, you can find the current release
[here](https://osuushi.github.io/scarf-seams)

## Development

Clone the repo with `git clone https://github.com/osuushi/scarf-seams`, then, from the
repo directory, run:

```bash
npm install
npm run dev
```

That will start the local dev server. To build a static page, run `npm run build`. The
project builds into a single HTML file which should run correctly in a modern browser
using a file:/// url.