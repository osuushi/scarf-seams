import { ProcessorParameters } from "./lib/processor";
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
      const gcode = await getFileText(fileInputEl);
      console.log(gcode);
    } catch (err) {
      window.alert(err);
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
