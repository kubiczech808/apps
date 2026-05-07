const form = document.querySelector("#campaignForm");
const editor = document.querySelector("#editor");
const html = document.querySelector("#bodyHtml");

document.querySelectorAll("[data-cmd]").forEach((button) => {
  button.addEventListener("click", () => {
    document.execCommand(button.dataset.cmd, false, null);
    editor.focus();
  });
});

const link = document.querySelector("[data-link]");
if (link) {
  link.addEventListener("click", () => {
    const url = prompt("URL odkazu");
    if (url) document.execCommand("createLink", false, url);
    editor.focus();
  });
}

if (form) {
  form.addEventListener("submit", () => {
    html.value = editor.innerHTML;
  });
}
