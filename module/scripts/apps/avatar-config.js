import { MODULE_ID, L } from "../constants.js";
import { AVATAR_FLAG, SCALE_MIN, SCALE_MAX, BOX, OFFSET_MAX, avatarFor, normalizeAvatar, illustrationSize } from "../avatar.js";

const { ApplicationV2 } = foundry.applications.api;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PX = 90; // preview pixels per block

/** "My 3D look": box colour, front illustration and its size, with a live front-view preview. */
export class AvatarConfig extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "bwb-avatar",
    classes: ["bwb", "bwb-avatar"],
    tag: "form",
    window: { title: "BWB.Avatar.Title", icon: "fa-solid fa-user-astronaut" },
    position: { width: 400, height: "auto" },
    form: { handler: AvatarConfig.#save, closeOnSubmit: true },
    actions: { browse: AvatarConfig.#browse, clearImage: AvatarConfig.#clearImage, center: AvatarConfig.#center }
  };

  async _renderHTML() {
    const a = avatarFor(game.user);
    return `
      <div class="bwb-avatar-body">
        <div class="bwb-avatar-preview"><div class="bwb-avatar-box"><img alt=""></div></div>
        <div class="bwb-avatar-fields">
          <label>${L("Avatar.Color")}</label>
          <input type="color" name="color" value="${esc(a.color)}">
          <label>${L("Avatar.Image")}</label>
          <div class="bwb-row">
            <input type="text" name="image" value="${esc(a.image)}" placeholder="${L("Avatar.NoImage")}">
            <button type="button" data-action="browse" title="${L("Avatar.Browse")}"><i class="fa-solid fa-file-import"></i></button>
            <button type="button" data-action="clearImage" title="${L("Avatar.Clear")}"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <label>${L("Avatar.Scale")} <output name="scaleOut"></output></label>
          <input type="range" name="scale" min="${SCALE_MIN}" max="${SCALE_MAX}" step="0.05" value="${a.scale}">
          <input type="hidden" name="offsetX" value="${a.offsetX}">
          <input type="hidden" name="offsetY" value="${a.offsetY}">
          <div class="bwb-row">
            <span class="bwb-hint">${L("Avatar.DragHint")}</span>
            <button type="button" data-action="center" title="${L("Avatar.Center")}"><i class="fa-solid fa-crosshairs"></i></button>
          </div>
          <p class="bwb-hint">${L("Avatar.Hint")}</p>
        </div>
      </div>
      <footer class="form-footer"><button type="submit"><i class="fa-solid fa-floppy-disk"></i> ${L("Avatar.Save")}</button></footer>`;
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  _onRender() {
    this.element.addEventListener("input", () => this.preview());
    this.bindDrag();
    this.element.querySelector('[name="image"]').addEventListener("change", () => this.preview());
    this.preview();
  }

  values() {
    const f = (n) => this.element.querySelector(`[name="${n}"]`).value;
    return normalizeAvatar({ color: f("color"), image: f("image"), scale: f("scale"), offsetX: f("offsetX"), offsetY: f("offsetY") });
  }

  /** Front view of the box at true proportions; the picture may spill past the box edges. */
  preview() {
    const v = this.values();
    const box = this.element.querySelector(".bwb-avatar-box");
    const img = box.querySelector("img");
    box.style.background = v.color;
    box.style.width = `${BOX.w * PX}px`;
    box.style.height = `${BOX.h * PX}px`;
    this.element.querySelector('[name="scaleOut"]').textContent = `${Math.round(v.scale * 100)}%`;
    const place = () => {
      const s = illustrationSize(img.naturalWidth / img.naturalHeight, v.scale);
      Object.assign(img.style, {
        width: `${s.w * PX}px`, height: `${s.h * PX}px`, display: "",
        left: `calc(50% + ${v.offsetX * PX - (s.w * PX) / 2}px)`, top: `calc(50% - ${v.offsetY * PX + (s.h * PX) / 2}px)`
      });
    };
    if (!v.image) { img.style.display = "none"; img.removeAttribute("src"); return; }
    if (img.getAttribute("src") !== v.image) { img.onload = place; img.onerror = () => { img.style.display = "none"; }; img.src = v.image; }
    else if (img.complete && img.naturalWidth) place();
  }

  setField(name, value) { this.element.querySelector(`[name="${name}"]`).value = value; }

  /** Drag the picture in the preview to move it; the mouse wheel there changes its size. */
  bindDrag() {
    const area = this.element.querySelector(".bwb-avatar-preview");
    let start = null;
    area.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || !this.values().image) return;
      const v = this.values();
      start = { x: ev.clientX, y: ev.clientY, ox: v.offsetX, oy: v.offsetY };
      area.setPointerCapture(ev.pointerId);
      area.classList.add("dragging");
      ev.preventDefault();
    });
    area.addEventListener("pointermove", (ev) => {
      if (!start) return;
      const clamp = (n, m) => Math.min(m, Math.max(-m, n));
      this.setField("offsetX", clamp(start.ox + (ev.clientX - start.x) / PX, OFFSET_MAX.x));
      this.setField("offsetY", clamp(start.oy - (ev.clientY - start.y) / PX, OFFSET_MAX.y)); // screen down = lower
      this.preview();
    });
    const end = () => { start = null; area.classList.remove("dragging"); };
    area.addEventListener("pointerup", end);
    area.addEventListener("pointercancel", end);
    area.addEventListener("wheel", (ev) => {
      if (!this.values().image) return;
      ev.preventDefault();
      const input = this.element.querySelector('[name="scale"]');
      const next = Number(input.value) * (ev.deltaY < 0 ? 1.08 : 1 / 1.08);
      input.value = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
      this.preview();
    }, { passive: false });
  }

  static #center() {
    this.setField("offsetX", 0);
    this.setField("offsetY", 0);
    this.preview();
  }

  static #browse() {
    const input = this.element.querySelector('[name="image"]');
    const FP = foundry.applications.apps.FilePicker.implementation;
    new FP({ type: "image", current: input.value, callback: (path) => { input.value = path; this.preview(); } }).render(true);
  }

  static #clearImage() {
    this.element.querySelector('[name="image"]').value = "";
    this.preview();
  }

  static async #save(event, form, formData) {
    const o = formData.object;
    const v = normalizeAvatar({ color: o.color, image: o.image, scale: o.scale, offsetX: o.offsetX, offsetY: o.offsetY });
    await game.user.setFlag(MODULE_ID, AVATAR_FLAG, v);
  }
}
