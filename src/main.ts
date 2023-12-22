import { process } from "./lib/processor";
import "./style.css";

const processForm = document.querySelector("#process-form");
if (processForm) {
  processForm.addEventListener("submit", async (event) => {
    try {
      event.preventDefault();
      const layerHeightEl = document.querySelector(
        "#layer-height"
      ) as HTMLInputElement;
      const overlapEl = document.querySelector("#overlap") as HTMLInputElement;
      const fileInputEl = document.querySelector(
        "#choose-file"
      ) as HTMLInputElement;
      const loopToleranceEl = document.querySelector(
        "#loop-tolerance"
      ) as HTMLInputElement;
      const taperResolutionEl = document.querySelector(
        "#taper-resolution"
      ) as HTMLInputElement;

      const layerHeight = layerHeightEl.valueAsNumber;
      const overlap = overlapEl.valueAsNumber;
      const loopTolerance = loopToleranceEl.valueAsNumber;
      const taperResolution = taperResolutionEl.valueAsNumber;
      const inputGcode = await getFileText(fileInputEl);
      const outputGcode = process({
        gcode: inputGcode,
        layerHeight,
        overlap,
        loopTolerance,
        taperResolution,
      });

      // Remove any existing download button
      document.querySelector("#download-button")?.remove?.();

      // Create a new download button, just for the original gcode right now
      const downloadButtonA = document.createElement("a");
      downloadButtonA.style.marginLeft = "1em";
      const downloadButton = Object.assign(document.createElement("button"), {
        textContent: "Download GCode",
        type: "button",
      });

      downloadButtonA.appendChild(downloadButton);
      downloadButtonA.id = "download-button";

      downloadButtonA.download = `${
        fileInputEl.files?.[0]?.name ?? "unknown"
      }-processed.gcode`;
      const blob = new Blob([outputGcode], { type: "text/plain" });
      downloadButtonA.href = URL.createObjectURL(blob);
      document.querySelector("#process-button")?.after?.(downloadButtonA);
    } catch (err) {
      window.alert(err);
      console.error(err);
    }
  });
}

function getFileText(fileInput: HTMLInputElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const file = fileInput.files?.[0];
    if (!file) {
      reject(new Error("No file selected"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      reject(reader.error);
    };
    reader.readAsText(file);
  });
}
