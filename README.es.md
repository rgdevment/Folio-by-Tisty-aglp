# Folio by Tisty

[English](README.md)

Folio by Tisty convierte un documento de Tisty en un link que cualquiera puede
leer: anónimo, cifrado de punta a punta, y que se va solo después de un tiempo.
Es un **servicio**, aparte de la app Tisty, con su propio servidor, sus reglas y
sus promesas. Sus links viven en tisty.cl, y su sitio es
[www.tisty.app](https://www.tisty.app).

> **No promete lo que promete la app.** La app Tisty no tiene servidor y no
> recolecta nada. Folio sí tiene un servidor: guarda copias cifradas
> hasta que caducan, cuenta lecturas y lleva algunos registros anónimos. Qué
> guarda, para qué y por cuánto tiempo está en su
> [política de privacidad](docs/PRIVACIDAD.md).

## Cómo funciona

- **Se comparte desde Tisty,** con su botón *Compartir*, que todavía no está
  encendido. No hay otra forma de compartir, y no hay cuentas: el link es el
  permiso.
- **Cada documento tiene tres links:** uno para leer, uno para editar y uno
  para administrar.
- **Lo que compartes se cifra en tu Tisty antes de salir.** La llave viaja en
  el link, después del `#`, que los navegadores nunca envían. El servidor
  guarda bytes que no puede leer.
- **Cada versión va firmada** con la llave de tu equipo, así quien lee sabe que
  viene de ti.
- **Caduca sola** después del tiempo sin actividad que elijas, de un día a 15
  como mucho. Tu documento se queda en tu Tisty.
- **Un link se abre en cualquier navegador,** en tisty.cl, o en otro Tisty con
  *Abrir en Tisty*.

## Sus documentos

| | |
|---|---|
| [Términos de uso](docs/TERMINOS.md) | Qué se permite, denuncias y retiro, garantías y responsabilidad |
| [Política de privacidad](docs/PRIVACIDAD.md) | Qué guarda el servicio, para qué, por cuánto tiempo, y tus derechos |
| [Política de seguridad](docs/SEGURIDAD.md) | Cómo reportar una vulnerabilidad, y qué protege el diseño y qué no |

## Quién lo opera

Mario, persona natural en Chile, como proyecto de código abierto y sin fines de
lucro. No hay una empresa detrás y nadie gana dinero con él. Contacto:
<rgdevment@tisty.app>.

## Su código

Se está escribiendo de nuevo desde cero en TypeScript, sobre Cloudflare Workers,
D1 y R2, y el servicio no corre mientras tanto. Se entiende con la
[app Tisty](https://github.com/rgdevment/Tisty) por un contrato que guarda el
repositorio de la app: los formatos de lo que viaja y las reglas de estilo de la
hoja. El código anterior, en Rust, queda en la rama
`chore/rust-service-backup`.

## Licencia

La misma de Tisty: la
[GNU Affero General Public License, versión 3](LICENSE).
Hay [términos comerciales](docs/COMMERCIAL.md) para organizaciones que no
pueden cumplir la AGPL.
