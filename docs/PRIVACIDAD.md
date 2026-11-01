# Privacidad de Tisty Share

**Borrador del 29 de octubre de 2026.** Tisty Share todavía no está abierto.

## En corto

Tisty Share guarda lo mínimo para funcionar, y casi todo va cifrado con una
llave que nunca recibe. No hay cuentas, ni cookies, ni analítica, ni anuncios,
ni nada de terceros en la página. Lo que guarda caduca solo. Esta política
cuenta exactamente qué guarda, por qué y por cuánto tiempo.

Quién responde por estos datos: Mario, persona natural en Chile, que opera
Tisty Share sin fines de lucro. Contacto: <rgdevment@tisty.app>.

## Lo que no puede ver

- **El contenido de lo que compartes.** El texto, las imágenes y la firma
  interna van cifrados en tu Tisty antes de salir. La llave va en el link,
  después del `#`, y los navegadores no la envían al servidor.
- **Quién eres.** No hay cuentas, ni correos, ni nombres.
- **Tu clave**, si pusiste una. El servidor guarda solo un resumen lento de ella
  (un hash), que sirve para comprobarla y no para recuperarla.

## Lo que sí guarda, y por cuánto tiempo

| Qué | Para qué | Por cuánto tiempo |
|---|---|---|
| El documento cifrado, con sus versiones | Servirlo a quien tiene el link | Hasta 30 días sin actividad, o hasta que dejes de compartirlo |
| El manifiesto en claro: cuántas partes tiene, cuánto pesa cada una, de qué tipo son y su versión | Aplicar los topes sin leer el contenido | Lo mismo que el documento |
| Los links de editar y administrar, guardados como resumen (hash) | Comprobar quién puede cambiar o borrar | Lo mismo que el documento |
| Si firmas, tu llave pública y su certificado | Que quien lee sepa que es tuyo | Lo mismo que el documento |
| Cuántas veces se leyó, contando una vez por día y por visitante | Mostrarte las lecturas en Tisty | Lo mismo que el documento |
| Un resumen de tu IP (un HMAC con una llave que cambia) | Topes por IP y bloqueos ante abuso | Lo que dura la cuota o el bloqueo |
| En un documento con clave: un resumen de tu red y de los bloques IPv6 en que está, las claves equivocadas que se le cuentan y que hoy dijo la correcta | Para que las claves equivocadas hagan esperar solo a la red que las dice, y quien ya entró no espere | Hasta que terminan el tramo de 15 minutos o el día |
| Las llaves que retiraste, como las firmó tu raíz: la parte pública de la llave y la de tu raíz | Para que quien lea sepa que una llave robada o retirada ya no habla por ti | Para siempre, porque quien lea siempre tiene que poder saberlo |
| Las denuncias: categoría, detalle, si lo dejaron el link, y un resumen de la red de quien denuncia (un HMAC con una llave que cambia cada 90 días), para que cada red denuncie una sola vez | Moderar y enviarlas a quien corresponde | 90 días, o 180 si la Fiscalía lo ordena |

**Sobre la firma:** si firmas lo que compartes, tu llave pública permite saber
que dos documentos firmados son de la misma persona, aunque no quién eres. En lo
no listado firmar es opcional por eso.

**Sobre las lecturas:** se cuentan sin guardar quién leyó. Para no contar dos
veces a la misma persona el mismo día se usa un resumen temporal, que se
descarta al terminar el día.

## Cloudflare

Tisty Share corre en Cloudflare (Workers, D1 y R2). Cloudflare recibe tu IP y
las peticiones al conectarte, como cualquier servidor web, y las trata según su
propia [política de privacidad](https://www.cloudflare.com/privacypolicy/).
Nunca recibe la llave del `#`, así que tampoco puede leer lo que compartes.

## La promesa del cifrado, dicha con honestidad

- **Entre dos Tisty**, nadie más puede leer lo compartido: ni el operador, ni
  Cloudflare, ni quien robe la base de datos.
- **En el navegador**, el código que descifra lo entrega el mismo servidor. Eso
  protege contra una filtración o una orden sobre lo guardado, pero no contra un
  operador que decidiera cambiar ese código para robar llaves. El código es
  público para que cualquiera pueda revisarlo.
- **Una denuncia con el link completo** permite abrir ese documento. Solo se
  hace en los casos que dicen los [términos](TERMINOS.md), y cada apertura
  queda registrada.

## Tus derechos

Bajo la Ley 21.719 puedes pedir saber qué datos tuyos hay, corregirlos,
borrarlos u oponerte a su uso. Como no hay cuentas, lo más directo es:

- **Borrar lo que compartiste:** con tu link de administración, o dejando de
  compartirlo desde Tisty. Se borra del servidor de inmediato.
- **Cualquier otra petición:** escribe a <rgdevment@tisty.app>. El resumen de
  tu IP no permite saber quién eres, así que en general no hay datos que
  puedan asociarse a ti.

## Menores de edad

Tisty Share no está pensado para menores de 14 años.

## Cambios

Cada cambio a esta política queda en el repositorio público, con su fecha.

[English](PRIVACY.md)
