# SoloTodo MCP

**En producción:** `https://solotodo.mmoraga.dev/mcp`

Servidor [MCP](https://modelcontextprotocol.io) que expone los datos públicos de
[SoloTodo.cl](https://www.solotodo.cl) —precios, specs, historial y evaluaciones— como
herramientas para agentes de IA.

En vez de abrir fichas una por una en el sitio, le pides a tu asistente:

> *"búscame notebooks con RTX 4050 y 16 GB bajo $1.000.000, y dime si el precio de hoy es bueno"*

y el agente filtra, compara el historial y responde. Se apoya en la API pública
(`publicapi.solotodo.com`); no hay scraping de HTML.

---

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `listar_categorias` | Lista las 70 categorías de SoloTodo. Punto de partida cuando no se conoce el nombre exacto. |
| `filtros_categoria` | Descubre qué specs se pueden filtrar en una categoría y qué valores acepta cada filtro. |
| `buscar_productos` | Búsqueda combinada: categoría + texto + precio en CLP + specs + tiendas. Devuelve el mejor precio vigente. |
| `detalle_producto` | Ficha completa: specs y precio en cada tienda con stock, con enlace directo. |
| `historial_precio` | Mínimo/máximo/habitual del período y **detección de ofertas infladas**. |
| `comparar_productos` | Tabla lado a lado de 2 a 6 productos, mostrando solo las specs en que difieren. |
| `comentarios_producto` | Evaluaciones de compradores: nota del producto, nota de la tienda y comentarios. |

### Detección de ofertas infladas

La maniobra habitual antes de un CyberDay es subir el *precio normal* para exhibir un
descuento grande sobre una referencia que nadie pagó. `historial_precio` compara el precio
normal de hoy contra su mediana del período: si está inflado y el precio que realmente se
paga no bajó, lo marca explícitamente.

```
**Conclusión:** hoy el mejor precio es $819.990, un 9% sobre el mínimo del período
($749.990). Si no es urgente, conviene esperar.

| Tienda | Precio hoy | Mín. período | Máx. período | Habitual | Veredicto        |
| ------ | ---------- | ------------ | ------------ | -------- | ---------------- |
| Paris  | $819.990   | $749.990     | $1.599.990   | $969.990 | 🟢 Buen precio   |
```

---

## Uso rápido

```bash
npm install
npm run dev        # http://localhost:8787/mcp
npm test           # pruebas unitarias y de protocolo (sin red)
npm run test:live  # pruebas contra la API real de SoloTodo
npm run deploy     # despliegue a Cloudflare Workers
```

### Conectarlo a un cliente MCP

```bash
# Claude Code, contra el servidor en producción
claude mcp add --transport http solotodo https://solotodo.mmoraga.dev/mcp

# ...o contra el servidor local durante desarrollo
claude mcp add --transport http solotodo-dev http://localhost:8787/mcp
```

O en la configuración de un cliente que use JSON:

```json
{
  "mcpServers": {
    "solotodo": { "type": "http", "url": "https://solotodo.mmoraga.dev/mcp" }
  }
}
```

El transporte es **streamable HTTP** en modo stateless: cada `POST /mcp` es autocontenido,
no hay sesión ni SSE, y por lo tanto no se necesitan Durable Objects.

### Ejemplo de llamada directa

```bash
curl -s https://solotodo.mmoraga.dev/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"buscar_productos",
        "arguments":{"categoria":"notebooks","precio_max_clp":1000000,
                     "specs":{"ram_quantity":16,"video_cards":["RTX 4050"]}}}}'
```

---

## Cómo está armado

```
src/
├── index.ts              Worker: Hono, rutas /mcp, /health, /
├── mcp/
│   ├── server.ts         Dispatcher JSON-RPC 2.0 y registro de herramientas
│   └── types.ts          Tipos del protocolo y helper `defineTool`
├── solotodo/
│   ├── client.ts         Cliente HTTP con caché en dos capas
│   ├── api.ts            Endpoints tipados
│   ├── categories.ts     Resolución difusa de categorías
│   ├── filters.ts        Traducción specs humanas → query params
│   └── types.ts
├── tools/                Una herramienta MCP por archivo
└── lib/
    ├── price-analysis.ts Estadísticas de historial y ofertas infladas
    ├── format.ts         Precios en CLP y tablas markdown
    └── text.ts           Matching sin acentos
```

### La parte no obvia: los filtros piden IDs, no valores

Este es el detalle que hace falta traducir y que justifica el servidor. Filtrar notebooks
con al menos 16 GB de RAM **no** se hace con el valor:

```
GET /categories/1/browse/?ram_quantity_min=16
→ 400 "Select a valid choice. That choice is not one of the available choices."
```

Hay que mandar el **id del choice** que representa "16 GB" en esa categoría:

```
GET /categories/1/browse/?ram_quantity_min=103202   ✅
```

Esos ids viven en `/category_specs_form_layouts/?category=<id>&website=1`, cambian por
categoría y no son adivinables. `src/solotodo/filters.ts` los resuelve desde texto natural
("16", `"16 GB"`, `"RTX 4050"`), redondeando **hacia arriba** en los umbrales: pedir 12 GB
aplica el corte de 16 GB en vez de devolver equipos de 8 GB.

Otras particularidades de la API, todas verificadas contra producción y cubiertas por
`test/live.test.ts`:

- Los filtros de precio son en **USD** (`offer_price_usd_max`); los precios que se muestran
  vienen en CLP dentro de `prices_per_currency`. La conversión usa el tipo de cambio que
  publica la propia API en `/currencies/`.
- Los filtros booleanos se validan como **entero** (`screen_touch=1`), no como `true`.
- El filtro de evaluaciones es `products` en **plural**; `product` se ignora en silencio y
  devuelve el catálogo completo.
- `ordering` acepta `offer_price_usd`, `normal_price_usd`, `relevance`, `discount` y `leads`.
  No existe el orden descendente con prefijo `-`.

### Caché

Dos capas, para golpear lo menos posible una API de terceros:

1. **Memo por request** — deduplica llamadas dentro de una misma ejecución de herramienta
   (el layout de filtros se consulta varias veces al resolver specs).
2. **Cache API de Cloudflare** — comparte respuestas entre requests, TTL configurable en
   `SOLOTODO_CACHE_TTL` (900 s por defecto).

## Configuración

| Variable | Default | Descripción |
|---|---|---|
| `SOLOTODO_API_BASE` | `https://publicapi.solotodo.com` | Base de la API upstream. |
| `SOLOTODO_CACHE_TTL` | `900` | TTL de caché en segundos. `0` la desactiva. |
| `SOLOTODO_TIMEOUT_MS` | `20000` | Timeout por request upstream. |

Se definen en `wrangler.jsonc`; para desarrollo local se pueden sobrescribir copiando
`.dev.vars.example` a `.dev.vars`.

---

## Estado

**Fase 1 (MVP) — completa y desplegada** en `https://solotodo.mmoraga.dev/mcp`
(Cloudflare Workers). Las siete herramientas funcionan contra la API real.

**Fase 2 — pendiente.** Vigilancia de precios con estado: tabla D1 de productos vigilados,
herramientas `vigilar_producto` / `dejar_de_vigilar` / `listar_vigilados`, y un Cron Trigger
que compare precios y dispare alertas. Los bindings están comentados en `wrangler.jsonc`.
Queda por decidir el canal de notificación (Telegram / email / otro).

**Fase 3 — pendiente.** Publicación open source bajo Root SpA, elección de licencia,
rate limiting propio y evaluación de una versión hosted en RapidAPI.

### Riesgo a vigilar

La API pública de SoloTodo no declara garantías de estabilidad ni términos de uso explícitos
para terceros. Antes de publicar este servidor conviene revisar sus términos y contactar a
SoloTodo. Mientras tanto: caché agresiva, un `User-Agent` identificable y sin paralelismo
agresivo contra el upstream.

Las pruebas de `test/live.test.ts` incluyen un bloque **contrato de la API upstream** que
falla si SoloTodo cambia las convenciones de las que depende este servidor.

---

Datos de [SoloTodo.cl](https://www.solotodo.cl). Este proyecto no está afiliado a SoloTodo.
