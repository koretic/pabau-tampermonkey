# Limitaciones y dependencias del script

## Aviso importante

Este script ha sido diseñado y desarrollado exclusivamente para funcionar con el estado actual de la plataforma Pabau en la fecha de **15 de julio de 2026**. Depende de elementos externos a nosotros que pueden cambiar en cualquier momento sin previo aviso.

> **Cualquier actualización que Pabau realice en su plataforma podrá requerir una revisión y posible adaptación del script.** Esto no está incluido en el servicio inicial de desarrollo salvo que se contrate un acuerdo de mantenimiento específico.

---

## 1. La plataforma Pabau puede cambiar su estructura interna

### Qué hacemos
El script necesita encontrar elementos concretos dentro de la página web de Pabau para funcionar correctamente. Por ejemplo:
- El campo donde aparece el número de factura
- El botón para guardar cambios
- La pestaña donde se realizan los pagos
- Los botones de cada método de pago (tarjeta, efectivo, etc.)

### Por qué puede dejar de funcionar
Pabau es una aplicación web que puede actualizarse continuamente. Cuando cambian su diseño, los nombres de los elementos internos o la estructura de la página, el script deja de encontrar lo que busca.

### Qué pasaría
El script no podría bloquear el botón de guardar ni verificar los documentos. En pantalla no se mostraría ningún bloqueo ni ninguna alerta.

---

## 2. Los nombres de los archivos firmados

### Qué hacemos
Cuando subes un documento firmado a Pabau, la plataforma guarda el nombre del archivo de forma interna. El script busca esos archivos usando el mismo formato que Pabau utiliza internamente.

### Por qué puede dejar de funcionar
Si Pabau cambia cómo guarda los nombres de los archivos (por ejemplo, si antes guardaba "documento.pdf" y ahora guarda "documento (1).pdf"), el script no podrá encontrar los documentos aunque ya estén subidos.

### Qué pasaría
El script mostraría que faltan documentos cuando en realidad ya están subidos. Serían falsos positivos.

---

## 3. La dirección web (URL) de cada cliente

### Qué hacemos
El script lee la dirección del navegador para saber a qué cliente corresponde la factura que está revisando. Por ejemplo, reconoce URLs como `https://app.pabau.com/clients/12345/financial`.

### Por qué puede dejar de funcionar
Si Pabau cambia el formato de sus direcciones web (por ejemplo, si cambia de números de cliente a códigos alfanuméricos), el script no podría identificar al cliente.

### Qué pasaría
El script no podría consultar los datos del cliente y no funcionaría en absoluto.

---

## 4. Los métodos de pago disponibles

### Qué hacemos
El script bloquea los botones de los métodos de pago (tarjeta, efectivo, puntos, vales, etc.) para evitar cobrar hasta que la documentación esté completa.

### Por qué puede dejar de funcionar
Pabau puede añadir nuevos métodos de pago, eliminar algunos o cambiar cómo se llaman. Si el script no reconoce un botón, no podrá bloquearlo.

### Qué pasaría
Algunos métodos de pago podrían quedar desbloqueados cuando no deberían.

---

## 5. La clave de acceso a la API

### Qué hacemos
El script utiliza una clave de acceso (API key) para comunicarse con los servidores de Pabau y obtener los datos de facturas y documentos.

### Por qué puede dejar de funcionar
Si Pabau cambia su sistema de seguridad o caduca la clave, el script no podrá conectarse a sus servidores.

### Qué pasaría
El script mostraría errores de acceso y no podría verificar ningún documento.

---

## Resumen para entenderlo mejor

Imagina que el script es como un **traductor automático** que funciona con un libro específico (la versión actual de Pabau). Si el editor del libro cambia el formato, las páginas o incluso el idioma del libro, el traductor dejará de funcionar hasta que alguien lo actualice para esa nueva versión.

| Qué puede cambiar | Qué sucede si cambia |
|-------------------|----------------------|
| Estructura de la página web | El script no encuentra los botones ni campos |
| Nombres de archivos guardados | Falsos positivos: dice que faltan documentos |
| Formato de las URLs | No puede identificar al cliente |
| Métodos de pago | Algunos pagos quedan sin bloquear |
| Sistema de acceso (API key) | No puede conectarse a los servidores |

---

## Qué hacer si el script deja de funcionar

1. **Comprueba** si Pabau ha realizado alguna actualización reciente en su plataforma (normalmente lo announce en su web o por email).
2. **Escríbenos** indicándonos:
   - Qué es lo que no funciona o qué errores aparecen
   - Una captura de pantalla del problema si es posible
   - La fecha aproximada en que dejó de funcionar

Con esa información podremos evaluar qué ha cambiado y preparar una actualización del script.
