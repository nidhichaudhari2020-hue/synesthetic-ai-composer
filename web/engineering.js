// Native dialog keeps keyboard focus inside the diagram and supports Escape.
const architectureDialog = document.getElementById("architecture-dialog");
const architectureTrigger = document.getElementById("architecture-open");

if (architectureDialog && architectureTrigger) {
  architectureTrigger.addEventListener("click", () => {
    if (!architectureDialog.open) {
      architectureDialog.showModal();
      architectureTrigger.setAttribute("aria-expanded", "true");
    }
  });

  architectureDialog
    .querySelectorAll(".architecture-close, .architecture-done")
    .forEach((button) => {
      button.addEventListener("click", () => architectureDialog.close());
    });

  architectureDialog.addEventListener("click", (event) => {
    if (event.target !== architectureDialog || !architectureDialog.open) return;
    const bounds = architectureDialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom
    ) architectureDialog.close();
  });

  architectureDialog.addEventListener("close", () => {
    architectureTrigger.setAttribute("aria-expanded", "false");
    architectureTrigger.focus({ preventScroll: true });
  });
}
