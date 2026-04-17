async function loadDashboard() {
  const res = await fetch("/api/dashboard");
  const data = await res.json();

  document.getElementById("statTotal").textContent = data.stats.total;
  document.getElementById("statUsers").textContent = data.stats.usuarios;
  document.getElementById("statHoy").textContent = data.stats.hoy;
  document.getElementById("statMes").textContent = data.stats.mes;

  const userSelect = document.getElementById("user_id");
  userSelect.innerHTML = `<option value="">Todos los usuarios</option>`;

  for (const user of data.users) {
    const opt = document.createElement("option");
    opt.value = user.user_id;
    opt.textContent = `${user.display_name || user.username} (${user.user_id})`;
    userSelect.appendChild(opt);
  }

  const topContainer = document.getElementById("topUsers");
  topContainer.innerHTML = "";

  data.top.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "top-item";
    div.innerHTML = `
      <span>${index + 1}. ${item.display_name || item.username}</span>
      <strong>${item.total}</strong>
    `;
    topContainer.appendChild(div);
  });
}

function getFilters() {
  return {
    user_id: document.getElementById("user_id").value,
    anio: document.getElementById("anio").value,
    mes: document.getElementById("mes").value,
    semana: document.getElementById("semana").value,
    desde: document.getElementById("desde").value,
    hasta: document.getElementById("hasta").value
  };
}

function filtersToQuery(filters) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value !== "") params.append(key, value);
  }

  return params.toString();
}

async function loadTable() {
  const filters = getFilters();
  const query = filtersToQuery(filters);
  const res = await fetch(`/api/tiradas?${query}`);
  const data = await res.json();

  document.getElementById("tableTotal").textContent = `${data.total} tiradas`;

  const tbody = document.getElementById("tbodyRows");
  tbody.innerHTML = "";

  for (const row of data.rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.id}</td>
      <td>${row.fecha_local}</td>
      <td>${row.display_name}</td>
      <td>${row.username}</td>
      <td>${row.user_id}</td>
      <td>${row.anio}</td>
      <td>${row.mes}</td>
      <td>${row.semana_iso}</td>
      <td>${row.channel_id}</td>
      <td>${row.conteo}</td>
    `;
    tbody.appendChild(tr);
  }
}

function clearFilters() {
  document.getElementById("user_id").value = "";
  document.getElementById("anio").value = "";
  document.getElementById("mes").value = "";
  document.getElementById("semana").value = "";
  document.getElementById("desde").value = "";
  document.getElementById("hasta").value = "";
}

document.getElementById("applyFilters").addEventListener("click", async () => {
  await loadTable();
});

document.getElementById("clearFilters").addEventListener("click", async () => {
  clearFilters();
  await loadTable();
});

document.getElementById("exportExcel").addEventListener("click", () => {
  const filters = getFilters();
  const query = filtersToQuery(filters);
  window.location.href = `/api/export?${query}`;
});

(async function init() {
  await loadDashboard();
  await loadTable();
})();