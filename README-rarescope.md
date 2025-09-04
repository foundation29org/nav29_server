# Sistema de Rarescope - Documentación del Servidor

## Descripción

El sistema de Rarescope permite almacenar y gestionar los datos importantes del paciente, incluyendo necesidades principales y adicionales identificadas a través del análisis de Rarescope. Este sistema está diseñado para complementar la funcionalidad existente de AI features y proporcionar persistencia de datos para las necesidades del paciente.

## Estructura de Archivos

```
├── models/
│   └── rarescope.js                    # Modelo de datos de MongoDB
├── controllers/user/patient/
│   └── rarescope.js                    # Controlador con la lógica de negocio
├── routes/index.js                      # Rutas de la API (ya actualizado)
├── docs/
│   └── rarescope-api.md                # Documentación completa de la API
├── test/
│   └── rarescope.test.js               # Tests unitarios
└── README-rarescope.md                  # Este archivo
```

## Características Principales

### 1. **Persistencia de Datos**
- Almacena las necesidades principales y adicionales del paciente
- Mantiene un historial completo de todas las versiones
- Actualiza automáticamente los datos existentes

### 2. **Validación de Datos**
- Verifica que el ID del paciente esté presente
- Asegura que al menos una necesidad sea proporcionada
- Valida la estructura de los datos entrantes

### 3. **Seguridad**
- Requiere autenticación del usuario
- Verifica permisos de acceso al paciente
- Valida la API key del servidor

### 4. **Funcionalidades CRUD**
- **CREATE/UPDATE**: Guardar o actualizar datos de Rarescope
- **READ**: Cargar datos actuales e historial
- **DELETE**: Eliminar todos los datos de un paciente

## Endpoints de la API

### Guardar Datos
```
POST /api/rarescope/save/:patientId
```

### Cargar Datos
```
GET /api/rarescope/load/:patientId
```

### Obtener Historial
```
GET /api/rarescope/history/:patientId?limit=10&page=1
```

### Eliminar Datos
```
DELETE /api/rarescope/delete/:patientId
```

## Integración con el Cliente

El sistema está diseñado para funcionar perfectamente con tu código del cliente:

```typescript
// Tu código actual funcionará sin cambios
saveRarescopeData() {
  const rarescopeData = {
    patientId: this.currentPatient.sub,
    mainNeed: this.rarescopeNeeds[0],
    additionalNeeds: this.additionalNeeds,
    updatedAt: new Date().toISOString()
  };

  this.http.post(`${environment.api}/api/rarescope/save`, rarescopeData)
    .subscribe(/* ... */);
}

loadRarescopeData() {
  this.http.get(`${environment.api}/api/rarescope/load/${this.currentPatient.sub}`)
    .subscribe(/* ... */);
}
```

## Modelo de Datos

```javascript
{
  patientId: String,           // ID del paciente (requerido, indexado)
  mainNeed: String,            // Necesidad principal identificada
  additionalNeeds: [String],   // Array de necesidades adicionales
  updatedAt: Date,             // Fecha de última actualización
  createdAt: Date              // Fecha de creación del registro
}
```

## Ventajas del Sistema

### 1. **Persistencia**
- Los datos se mantienen entre sesiones
- No se pierden al recargar la página
- Historial completo de cambios

### 2. **Eficiencia**
- Índices optimizados para búsquedas rápidas
- Actualización en lugar de creación duplicada
- Paginación para historiales largos

### 3. **Escalabilidad**
- Estructura preparada para futuras expansiones
- Separación clara de responsabilidades
- Fácil mantenimiento y testing

### 4. **Seguridad**
- Autenticación y autorización integradas
- Validación de datos en múltiples niveles
- Logs de errores para debugging

## Casos de Uso

### 1. **Análisis Inicial**
- El paciente ejecuta Rarescope por primera vez
- Los resultados se almacenan automáticamente
- Datos disponibles para futuras consultas

### 2. **Actualización de Necesidades**
- El paciente actualiza sus necesidades
- Se mantiene el historial de cambios
- Análisis de evolución temporal

### 3. **Consulta de Historial**
- Médicos pueden revisar la evolución
- Análisis de patrones de necesidades
- Toma de decisiones informada

### 4. **Sincronización Multi-dispositivo**
- Datos accesibles desde cualquier dispositivo
- Sincronización automática
- Consistencia de datos

## Instalación y Configuración

### 1. **Dependencias**
El sistema utiliza las dependencias existentes del proyecto:
- `mongoose` para MongoDB
- `express` para el servidor web
- Middlewares de autenticación existentes

### 2. **Base de Datos**
- Se crea automáticamente la colección `rarescopies`
- Índices se crean automáticamente
- Compatible con la configuración existente

### 3. **Rutas**
- Se integran automáticamente en el sistema de rutas existente
- Utilizan los middlewares de autenticación existentes
- Siguen el patrón de nomenclatura del proyecto

## Testing

El sistema incluye tests unitarios completos:

```bash
# Ejecutar tests (requiere Jest y mongodb-memory-server)
npm test test/rarescope.test.js
```

Los tests cubren:
- Creación y actualización de datos
- Carga de datos existentes
- Manejo de errores
- Validaciones de datos
- Operaciones de eliminación

## Mantenimiento

### 1. **Logs**
- Todos los errores se registran en consola
- Fácil debugging y monitoreo
- Trazabilidad completa de operaciones

### 2. **Backup**
- Los datos se almacenan en MongoDB
- Compatible con estrategias de backup existentes
- Exportación fácil de datos

### 3. **Monitoreo**
- Métricas de rendimiento disponibles
- Alertas de errores configurables
- Dashboard de estado del sistema

## Futuras Mejoras

### 1. **Funcionalidades Adicionales**
- Exportación de datos en múltiples formatos
- Análisis estadístico de necesidades
- Integración con sistemas externos

### 2. **Optimizaciones**
- Caché de datos frecuentemente accedidos
- Compresión de datos históricos
- Archivo de datos antiguos

### 3. **Integración**
- APIs para sistemas de salud
- Notificaciones automáticas
- Sincronización con calendarios médicos

## Soporte

Para soporte técnico o preguntas sobre el sistema:
1. Revisar la documentación de la API en `docs/rarescope-api.md`
2. Ejecutar los tests para verificar la funcionalidad
3. Revisar los logs del servidor para debugging
4. Consultar la documentación del proyecto principal

## Conclusión

El sistema de Rarescope proporciona una base sólida y escalable para almacenar y gestionar las necesidades importantes del paciente. Está diseñado para integrarse perfectamente con tu aplicación existente y proporcionar una experiencia de usuario mejorada con persistencia de datos.
