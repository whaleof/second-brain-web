// modules/absorption.js - 认知吸收卡独立入口
// 直接复用 cards/ 下已生成的 HTML 主卡，用 iframe 嵌入，保持与浏览器中打开一致。

const Absorption = {
  async render() {
    const content = document.getElementById('content');
    const path = 'cards/认知吸收·多主题卡.html?v=' + Date.now();
    content.innerHTML = `
      <div class="absorption-wrap">
        <iframe class="absorption-frame" src="${path}" title="认知吸收卡"></iframe>
      </div>`;
  }
};

window.Absorption = Absorption;
