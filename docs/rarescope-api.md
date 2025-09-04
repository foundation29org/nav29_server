# API de Rarescope

Esta API permite gestionar los datos importantes del paciente relacionados con Rarescope, incluyendo necesidades principales y adicionales.

## Endpoints

### 1. Guardar datos de Rarescope

**POST** `/api/rarescope/save/:patientId`

Guarda o actualiza los datos de Rarescope para un paciente específico.

**Headers requeridos:**
- `x-api-key`: Clave de API válida
- `Authorization`: Token de autenticación

**Parámetros de ruta:**
- `patientId`: ID del paciente

**Body de la petición:**
```json
{
  "mainNeed": "Falta de protocolos de atención estandarizados para el manejo de complicaciones asociadas como la trombosis venosa profunda",
  "additionalNeeds": [
    "Acceso limitado a tratamientos específicos para la distrofia muscular de cinturas tipo 2A",
    "Escasez de investigación clínica enfocada en calpainopatía para desarrollar nuevas terapias",
    "Insuficiente apoyo psicológico y social para afrontar el impacto de la enfermedad en la calidad de vida"
  ]
}
```

**Respuesta exitosa (200):**
```json
{
  "success": true,
  "message": "Datos de Rarescope guardados exitosamente",
  "data": {
    "_id": "64f8a1b2c3d4e5f6a7b8c9d0",
    "patientId": "patient123",
    "mainNeed": "Falta de protocolos de atención estandarizados...",
    "additionalNeeds": ["Acceso limitado a tratamientos...", "..."],
    "updatedAt": "2024-01-15T10:30:00.000Z",
    "createdAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### 2. Cargar datos de Rarescope

**GET** `/api/rarescope/load/:patientId`

Carga los datos más recientes de Rarescope para un paciente.

**Headers requeridos:**
- `x-api-key`: Clave de API válida
- `Authorization`: Token de autenticación

**Parámetros de ruta:**
- `patientId`: ID del paciente

**Respuesta exitosa (200):**
```json
{
  "success": true,
  "message": "Datos de Rarescope cargados exitosamente",
  "data": {
    "_id": "64f8a1b2c3d4e5f6a7b8c9d0",
    "patientId": "patient123",
    "mainNeed": "Falta de protocolos de atención estandarizados...",
    "additionalNeeds": ["Acceso limitado a tratamientos...", "..."],
    "updatedAt": "2024-01-15T10:30:00.000Z",
    "createdAt": "2024-01-15T10:30:00.000Z"
  }
}
```

### 3. Obtener historial de Rarescope

**GET** `/api/rarescope/history/:patientId?limit=10&page=1`

Obtiene el historial completo de datos de Rarescope para un paciente con paginación.

**Headers requeridos:**
- `x-api-key`: Clave de API válida
- `Authorization`: Token de autenticación

**Parámetros de ruta:**
- `patientId`: ID del paciente

**Parámetros de consulta (opcionales):**
- `limit`: Número de registros por página (default: 10)
- `page`: Número de página (default: 1)

**Respuesta exitosa (200):**
```json
{
  "success": true,
  "message": "Historial de Rarescope cargado exitosamente",
  "data": {
    "history": [
      {
        "_id": "64f8a1b2c3d4e5f6a7b8c9d0",
        "patientId": "patient123",
        "mainNeed": "Falta de protocolos de atención estandarizados...",
        "additionalNeeds": ["..."],
        "updatedAt": "2024-01-15T10:30:00.000Z",
        "createdAt": "2024-01-15T10:30:00.000Z"
      }
    ],
    "pagination": {
      "currentPage": 1,
      "totalPages": 1,
      "totalRecords": 1,
      "limit": 10
    }
  }
}
```

### 4. Eliminar datos de Rarescope

**DELETE** `/api/rarescope/delete/:patientId`

Elimina todos los datos de Rarescope para un paciente específico.

**Headers requeridos:**
- `x-api-key`: Clave de API válida
- `Authorization`: Token de autenticación

**Parámetros de ruta:**
- `patientId`: ID del paciente

**Respuesta exitosa (200):**
```json
{
  "success": true,
  "message": "Se eliminaron 1 registros de Rarescope exitosamente"
}
```

## Códigos de error

### 400 - Bad Request
```json
{
  "success": false,
  "error": "ID del paciente es requerido"
}
```

### 401 - Unauthorized
```json
{
  "error": "API Key no válida o ausente"
}
```

### 404 - Not Found
```json
{
  "success": false,
  "error": "No se encontraron datos de Rarescope para eliminar"
}
```

### 500 - Internal Server Error
```json
{
  "success": false,
  "error": "Error interno del servidor al guardar datos de Rarescope"
}
```

## Autenticación

Todas las rutas requieren:
1. **API Key**: Enviada en el header `x-api-key`
2. **Token de autenticación**: Enviado en el header `Authorization`
3. **Permisos**: El usuario debe tener acceso al paciente especificado

## Modelo de datos

```javascript
{
  patientId: String,           // ID del paciente (requerido)
  mainNeed: String,            // Necesidad principal
  additionalNeeds: [String],   // Array de necesidades adicionales
  updatedAt: Date,             // Fecha de última actualización
  createdAt: Date              // Fecha de creación
}
```

## Notas importantes

- Los datos se actualizan automáticamente si ya existe un registro para el paciente
- El campo `updatedAt` se actualiza automáticamente en cada modificación
- Se mantiene un historial completo de todas las versiones de los datos
- Las búsquedas están optimizadas con índices en `patientId` y `updatedAt`
