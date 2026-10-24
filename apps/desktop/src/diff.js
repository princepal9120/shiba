const patch = document.getElementById("patch");
const bridge = window.shibaDiff;
if (!patch || !bridge) {
  if (patch) patch.textContent = "Could not read the diff.";
} else {
  bridge.patch().then(
    (text) => {
      patch.textContent = text || "No diff was provided.";
    },
    () => {
      patch.textContent = "Could not read the diff.";
    },
  );
}
