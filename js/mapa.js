// La página que muestra dónde están mis celulares.
// Novedad: maneja VARIOS celulares. Cada uno tiene un nombre y su propia clave.
// Arriba hay un menú para elegir cuál ver.
//
// Cómo funciona, en resumen:
//   1. Guarda una lista de celulares (nombre + clave) y una sola URL de Firebase.
//   2. Cada 15 segundos LEE la última ubicación del celular elegido (un GET).
//   3. Mueve el punto en el mapa y actualiza los datos (hace cuánto, batería…).
//
// La página NUNCA habla con el celular directamente: las dos hablan con Firebase.

// ---------- 1. Configuración (URL + lista de celulares) ----------
// Formato guardado:
//   { urlBase: "...", seleccionado: 0, celulares: [ {nombre, clave}, ... ] }
function leerConfig() {
  let g = {};
  try { g = JSON.parse(localStorage.getItem("rastreador") || "{}"); } catch (e) {}

  // Compatibilidad: si venías de la versión vieja {urlBase, clave}, lo convertimos.
  if (g.clave && !g.celulares) {
    g = { urlBase: g.urlBase, seleccionado: 0, celulares: [{ nombre: "Mi celular", clave: g.clave }] };
  }

  const base = window.CONFIG || {};
  return {
    urlBase: (g.urlBase || base.urlBase || "").replace(/\/+$/, ""),
    celulares: Array.isArray(g.celulares) ? g.celulares : [],
    seleccionado: Number.isInteger(g.seleccionado) ? g.seleccionado : 0
  };
}

function guardarConfig(c) {
  localStorage.setItem("rastreador", JSON.stringify(c));
}

let config = leerConfig();

// ---------- 1b. Pasar la configuración de un celular a otro ----------
// localStorage es privado de cada navegador, así que la lista de celulares NO
// viaja sola entre tu PC y tu celular. Para llevarla, generamos un ENLACE que
// lleva la configuración metida adentro (codificada). Lo abres en el otro
// aparato y se carga todo de una.

// Convierte la config actual en un enlace que puedes abrir en otro celular.
function enlaceConfig() {
  const datos = { urlBase: config.urlBase, celulares: config.celulares };
  // JSON -> texto -> base64 (para que quepa en una dirección web).
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(datos))));
  return location.origin + location.pathname + "#c=" + encodeURIComponent(b64);
}

// Si la página se abrió con un enlace de esos (…#c=XXXX), importa la config.
// Devuelve true si importó algo.
function importarDesdeEnlace() {
  try {
    const m = (location.hash || "").match(/c=([^&]+)/);
    if (!m) return false;
    const texto = decodeURIComponent(escape(atob(decodeURIComponent(m[1]))));
    const datos = JSON.parse(texto);
    if (datos && datos.urlBase && Array.isArray(datos.celulares)) {
      config = {
        urlBase: String(datos.urlBase).replace(/\/+$/, ""),
        celulares: datos.celulares,
        seleccionado: 0
      };
      guardarConfig(config);
      // Limpiamos el enlace para que la clave no quede visible en la barra
      // de direcciones ni en el historial del navegador.
      history.replaceState(null, "", location.pathname + location.search);
      return true;
    }
  } catch (e) { console.error("Enlace de configuración inválido:", e); }
  return false;
}

// El celular que estamos viendo ahora (o null si no hay ninguno configurado).
function celularActual() {
  if (!config.celulares.length) return null;
  const i = Math.min(config.seleccionado, config.celulares.length - 1);
  return config.celulares[i];
}

// ---------- 2. El mapa ----------
const mapa = L.map("mapa").setView([5.535, -73.367], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap"
}).addTo(mapa);
L.Icon.Default.prototype.options.imagePath = "vendor/images/";

let marcador = null;      // el "pin" en el mapa
let circulo = null;       // el círculo de precisión alrededor del pin
let recorrido = null;     // la línea del recorrido (historial)
let yaCentre = false;     // para centrar el mapa solo la primera vez
let ultimoDato = null;    // el último reporte recibido

// ---------- 3. Leer el buzón ----------
// urlBase + "/celulares/" + clave + "/" + sufijo + ".json"
function direccion(sufijo) {
  const cel = celularActual();
  return `${config.urlBase}/celulares/${encodeURIComponent(cel.clave)}/${sufijo}.json`;
}

async function pedirUbicacion() {
  const cel = celularActual();
  // Sin configuración no hay nada que pedir: mostramos los ajustes.
  if (!config.urlBase || !cel || cel.clave.length < 20) {
    ponerEstado("gris", "Falta configurar (toca ⚙️)");
    // OJO: solo abrimos Ajustes si NO están ya abiertos. Si no, este temporizador
    // (que corre cada 15 s) volvería a redibujar la ventana y te BORRARÍA lo que
    // estás escribiendo. Ese era el bug de "pongo los datos y se borra todo".
    if (!caja.classList.contains("visible")) abrirConfig();
    return;
  }
  try {
    const resp = await fetch(direccion("ultima"), { cache: "no-store" });
    if (!resp.ok) throw new Error("respuesta " + resp.status);
    const dato = await resp.json();
    if (!dato || typeof dato.lat !== "number") {
      ponerEstado("gris", "Aún no hay reportes de «" + cel.nombre + "»");
      return;
    }
    ultimoDato = dato;
    pintar(dato);
    pintarRecorrido();
  } catch (e) {
    ponerEstado("viejo", "Sin conexión con Firebase");
    console.error(e);
  }
}

// Lee el historial y dibuja la línea del recorrido (los últimos 50 puntos).
async function pintarRecorrido() {
  try {
    const resp = await fetch(direccion("historial") + '?orderBy="$key"&limitToLast=50', { cache: "no-store" });
    if (!resp.ok) return;
    const hist = await resp.json();
    if (!hist) { if (recorrido) { recorrido.remove(); recorrido = null; } return; }
    const puntos = Object.keys(hist).sort()
      .map((k) => hist[k])
      .filter((d) => d && typeof d.lat === "number")
      .map((d) => [d.lat, d.lng]);
    if (puntos.length < 2) return;
    if (!recorrido) {
      recorrido = L.polyline(puntos, { color: "#4f7cff", weight: 4, opacity: .6 }).addTo(mapa);
    } else {
      recorrido.setLatLngs(puntos);
    }
  } catch (e) { /* si falla el historial, no pasa nada: el pin sigue */ }
}

// ---------- 4. Pintar en pantalla ----------
function pintar(dato) {
  const punto = [dato.lat, dato.lng];
  if (!marcador) marcador = L.marker(punto).addTo(mapa);
  else marcador.setLatLng(punto);

  if (dato.precision) {
    if (!circulo) {
      circulo = L.circle(punto, { radius: dato.precision, color: "#4f7cff", opacity: .4, fillOpacity: .1 }).addTo(mapa);
    } else {
      circulo.setLatLng(punto).setRadius(dato.precision);
    }
  }

  if (!yaCentre) { mapa.setView(punto, 16); yaCentre = true; }

  marcador.bindPopup(`Visto ${haceCuanto(dato.hora)}<br>${new Date(dato.hora).toLocaleString()}`);
  actualizarDatos(dato);
}

function actualizarDatos(dato) {
  document.getElementById("d-hace").textContent = haceCuanto(dato.hora);
  document.getElementById("d-bateria").textContent =
    (dato.bateria != null ? dato.bateria + " %" : "—") + (dato.cargando ? " ⚡" : "");
  document.getElementById("d-precision").textContent =
    dato.precision != null ? Math.round(dato.precision) + " m" : "—";
  document.getElementById("d-velocidad").textContent =
    dato.velocidad != null ? Math.round(dato.velocidad * 3.6) + " km/h" : "—";

  const minutos = (Date.now() - dato.hora) / 60000;
  if (minutos < 5) ponerEstado("vivo", "En línea · " + haceCuanto(dato.hora));
  else ponerEstado("viejo", "Última vez " + haceCuanto(dato.hora));
}

// ---------- 5. Ayudantes ----------
function haceCuanto(hora) {
  const seg = Math.max(0, Math.floor((Date.now() - hora) / 1000));
  if (seg < 60) return "hace " + seg + " s";
  const min = Math.floor(seg / 60);
  if (min < 60) return "hace " + min + " min";
  const h = Math.floor(min / 60);
  if (h < 24) return "hace " + h + " h";
  return "hace " + Math.floor(h / 24) + " días";
}

function ponerEstado(clase, texto) {
  const punto = document.getElementById("punto-estado");
  punto.className = "";
  if (clase === "vivo") punto.classList.add("vivo");
  if (clase === "viejo") punto.classList.add("viejo");
  document.getElementById("estado-texto").textContent = texto;
}

// Genera una clave secreta nueva al azar (24 letras y números).
function generarClave() {
  const letras = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 24; i++) s += letras[Math.floor(Math.random() * letras.length)];
  return s;
}

// ---------- 6. El menú de celulares (arriba) ----------
function pintarSelector() {
  const sel = document.getElementById("selector-celular");
  sel.innerHTML = "";
  if (!config.celulares.length) {
    const op = document.createElement("option");
    op.textContent = "(sin celulares)";
    sel.appendChild(op);
    sel.style.display = "none";
    return;
  }
  sel.style.display = "";
  config.celulares.forEach((c, i) => {
    const op = document.createElement("option");
    op.value = i;
    op.textContent = c.nombre || ("Celular " + (i + 1));
    if (i === config.seleccionado) op.selected = true;
    sel.appendChild(op);
  });
}

// Al cambiar de celular en el menú: reiniciamos el mapa y pedimos su ubicación.
document.getElementById("selector-celular").onchange = (e) => {
  config.seleccionado = Number(e.target.value);
  guardarConfig(config);
  reiniciarMapa();
  pedirUbicacion();
};

// Borra el pin, el círculo y el recorrido (para empezar limpio con otro celular).
function reiniciarMapa() {
  if (marcador) { marcador.remove(); marcador = null; }
  if (circulo) { circulo.remove(); circulo = null; }
  if (recorrido) { recorrido.remove(); recorrido = null; }
  ultimoDato = null;
  yaCentre = false;
}

// ---------- 7. Ventana de Ajustes ----------
const caja = document.getElementById("config-caja");

function abrirConfig() {
  document.getElementById("in-url").value = config.urlBase;
  pintarListaConfig(config.celulares.length ? config.celulares : [{ nombre: "", clave: "" }]);
  caja.classList.add("visible");
}
function cerrarConfig() { caja.classList.remove("visible"); }

// Dibuja la lista editable de celulares dentro de Ajustes.
function pintarListaConfig(celulares) {
  const cont = document.getElementById("lista-celulares");
  cont.innerHTML = "";
  celulares.forEach((c) => cont.appendChild(filaCelular(c.nombre, c.clave)));
}

// Crea una fila (nombre + clave + botones) para un celular.
function filaCelular(nombre, clave) {
  const item = document.createElement("div");
  item.className = "cel-item";

  const cab = document.createElement("div");
  cab.className = "cabecera";
  const inNombre = document.createElement("input");
  inNombre.className = "cel-nombre";
  inNombre.placeholder = "Nombre (ej. Moto, Cel de mamá)";
  inNombre.value = nombre || "";
  const btnQuitar = document.createElement("button");
  btnQuitar.className = "quitar";
  btnQuitar.textContent = "🗑";
  btnQuitar.title = "Quitar este celular";
  btnQuitar.onclick = () => item.remove();
  cab.appendChild(inNombre);
  cab.appendChild(btnQuitar);

  const filaClave = document.createElement("div");
  filaClave.className = "cel-clave-fila";
  const inClave = document.createElement("input");
  inClave.className = "cel-clave";
  inClave.placeholder = "Clave (20 letras o más)";
  inClave.value = clave || "";
  const btnGen = document.createElement("button");
  btnGen.className = "gris chico";
  btnGen.textContent = "Generar";
  btnGen.title = "Crear una clave nueva al azar";
  btnGen.onclick = () => { inClave.value = generarClave(); };
  filaClave.appendChild(inClave);
  filaClave.appendChild(btnGen);

  item.appendChild(cab);
  item.appendChild(filaClave);
  return item;
}

document.getElementById("btn-config").onclick = abrirConfig;
document.getElementById("btn-cancelar").onclick = cerrarConfig;

// Botón "Copiar enlace para otro celular": arma el enlace y lo copia.
document.getElementById("btn-enlace").onclick = async () => {
  if (!config.urlBase || !config.celulares.length) {
    alert("Primero guarda tu Firebase y al menos un celular.");
    return;
  }
  const enlace = enlaceConfig();
  try {
    await navigator.clipboard.writeText(enlace);
    alert("¡Enlace copiado! Mándatelo por WhatsApp a ti mismo y ábrelo en el otro " +
          "celular: se cargarán todos tus celulares.\n\n⚠️ No lo compartas con nadie: " +
          "lleva tus claves adentro.");
  } catch (e) {
    // Si el navegador no deja copiar solo, se lo mostramos para copiar a mano.
    prompt("Copia este enlace y ábrelo en el otro celular:", enlace);
  }
};
document.getElementById("btn-agregar").onclick = () => {
  document.getElementById("lista-celulares").appendChild(filaCelular("", ""));
};

document.getElementById("btn-guardar").onclick = () => {
  const url = document.getElementById("in-url").value.trim().replace(/\/+$/, "");
  // Recoger todos los celulares de la lista.
  const items = document.querySelectorAll("#lista-celulares .cel-item");
  const celulares = [];
  for (const it of items) {
    const nombre = it.querySelector(".cel-nombre").value.trim();
    const clave = it.querySelector(".cel-clave").value.trim();
    if (!clave && !nombre) continue;        // fila vacía: la ignoramos
    if (clave.length < 20) {
      alert("La clave de «" + (nombre || "un celular") + "» debe tener 20 letras o más.");
      return;
    }
    celulares.push({ nombre: nombre || ("Celular " + (celulares.length + 1)), clave });
  }
  if (!url) { alert("Escribe la dirección de Firebase."); return; }
  if (!celulares.length) { alert("Agrega al menos un celular con su clave."); return; }

  config = {
    urlBase: url,
    celulares,
    seleccionado: Math.min(config.seleccionado, celulares.length - 1)
  };
  guardarConfig(config);
  pintarSelector();
  reiniciarMapa();
  cerrarConfig();
  pedirUbicacion();
};

// ---------- 8. Arranque ----------
// Si abriste la página con un enlace de configuración, cárgalo primero.
importarDesdeEnlace();
pintarSelector();
pedirUbicacion();
setInterval(pedirUbicacion, 15000);
setInterval(() => { if (ultimoDato) actualizarDatos(ultimoDato); }, 1000);
