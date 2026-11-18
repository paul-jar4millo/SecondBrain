/**
 * Synthetic reference bank for demo mode. It only uses first-party images
 * shipped with the app, so the public demo hotlinks nothing.
 */
const base = import.meta.env.BASE_URL;
const pin = (
  id: string,
  titulo: string,
  file: string,
  etiquetas: string[],
) => ({
  id,
  url: base + file,
  imagen: base + file,
  titulo,
  consulta: "refugio",
  etiquetas,
});

export const demoReferences = {
  actualizado: "2026-11-01",
  fuente: "Recursos propios de la app (modo demo).",
  consultas: ["refugio"],
  pines: [
    pin("demo-marina", "Retrato de Marina", "portraits/marina.png", [
      "personaje",
    ]),
    pin("demo-ambar", "Retrato de Ámbar", "portraits/ambar.png", ["personaje"]),
    pin("demo-lira", "Retrato de Lira", "portraits/lira.png", ["personaje"]),
    pin("demo-menta", "Retrato de Menta", "portraits/menta.png", ["personaje"]),
    pin("demo-icono", "Icono del refugio", "brain-blue-512.png", [
      "marca",
      "azul",
    ]),
  ],
};
