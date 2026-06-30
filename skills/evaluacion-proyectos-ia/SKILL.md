---
name: evaluacion-proyectos-ia
description: Evalúa proyectos finales de Inteligencia Artificial, especialmente repositorios de estudiantes con informe Markdown, código, experimentos y actividad GitHub. Use cuando el usuario pida revisar si un proyecto cumple una consigna académica, evaluar informe, materiales y métodos, resultados, formalidad, código, reproducibilidad, issues, branches, PRs o generar recomendaciones/issue lists.
---

# Evaluación de proyectos de IA

Este skill guía la revisión de proyectos finales de Inteligencia Artificial similares a proyectos universitarios con repositorio, informe, código, experimentos y consigna. El objetivo es producir una evaluación clara, accionable y académicamente útil, separando el cumplimiento formal, la calidad del informe, la metodología, los resultados, la implementación y el proceso de desarrollo.

## Principios de evaluación

- Priorizar evidencia concreta: citar rutas de archivos, secciones del informe, comandos usados, issues/PRs, tablas o scripts.
- Separar observaciones de informe, código y proceso GitHub. No mezclar críticas metodológicas con problemas de implementación salvo que afecten la validez experimental.
- Distinguir entre:
  - cumplimiento estricto de la consigna,
  - calidad académica del informe,
  - solidez metodológica,
  - madurez técnica del código,
  - reproducibilidad,
  - trazabilidad del proceso de trabajo.
- Ser crítico pero constructivo: formular problemas como recomendaciones accionables.
- Cuando el usuario quiera cargar issues, agrupar en pocos issues amplios con checklists internas.
- Si la tarea es amplia, conviene usar subagentes/scouts para inspección paralela, pero la síntesis final debe quedar a cargo del agente principal.

## Flujo recomendado

### 1. Leer la consigna

Si la consigna está en Google Docs, usar `google_docs_get`. Si está en el repo, leer el archivo correspondiente. Extraer requisitos verificables, por ejemplo:

- ubicación y nombre del informe,
- extensión mínima,
- secciones obligatorias,
- ubicación del código,
- requisitos de ramas,
- issues, PRs, commits y participación,
- criterios de evaluación,
- presentación o entregables adicionales.

Convertir la consigna en una checklist.

### 2. Inspeccionar el repositorio

Usar `find`, `git status`, `git branch`, `git log`, `git remote -v` y lectura de archivos principales. Buscar:

- informes Markdown,
- README,
- estructura esperada del proyecto,
- código fuente,
- scripts de experimentación,
- datos y resultados,
- gráficos/tablas,
- tests,
- dependencias,
- configuración de entorno.

Si el usuario autoriza o lo pide, usar `gh` para revisar GitHub:

- issues,
- PRs,
- branches remotas,
- contributors,
- releases,
- actividad y comentarios.

### 3. Evaluar cumplimiento de consigna

Entregar una tabla con columnas:

| Requisito | Estado | Evidencia |
|---|---:|---|

Estados sugeridos:

- Cumple
- Cumple parcialmente
- No cumple
- No verificable

Criterios importantes en proyectos de IA de la materia:

- Informe en Markdown y en la ruta solicitada.
- Secciones mínimas: Introducción, Marco teórico, Diseño experimental o Materiales y métodos, Análisis/discusión de resultados, Conclusiones, Bibliografía.
- Código en la carpeta solicitada por la consigna.
- Experimentos con métricas, tablas y/o gráficos.
- Bibliografía citada en el cuerpo del texto.
- Issues para actividades/subactividades.
- Ramas `main` y `develop` si fueron exigidas.
- PRs desde rama de desarrollo a `main`.
- Evidencia de commits y participación.

### 4. Evaluar el informe

Revisar el informe desde estas dimensiones:

#### Estructura

- ¿Sigue la consigna?
- ¿Tiene secciones obligatorias?
- ¿El análisis y discusión está separado de los resultados?
- ¿Las conclusiones incluyen limitaciones o trabajo futuro cuando se solicita?

#### Marco teórico

- ¿Explica los algoritmos usados?
- ¿Justifica la elección del método?
- ¿Distingue correctamente conceptos cercanos? Ejemplo: TSP, TSPTW, VRP/VRPTW, modelo simplificado.
- ¿Usa citas explícitas para afirmaciones teóricas?

#### Materiales y métodos / diseño experimental

Verificar que el informe permita entender y reproducir el experimento. Buscar:

- fuente de datos,
- zona geográfica o dataset,
- cantidad de instancias/clientes/muestras,
- criterios de selección/descarte,
- generación de datos sintéticos,
- parámetros del algoritmo,
- barrido de parámetros,
- semillas o repeticiones,
- métricas,
- baselines,
- procedimiento experimental paso a paso.

Punto importante: si hay barrido de parámetros, distinguir si es:

- exhaustivo/grilla completa,
- aleatorio,
- univariado de sensibilidad,
- manual o ad hoc.

#### Resultados y discusión

Revisar:

- claridad de tablas y gráficos,
- unidades de cada métrica,
- medidas de tendencia central,
- medidas de dispersión: desviación estándar, IQR, rango mínimo/máximo o intervalos de confianza,
- interpretación causal o metodológica de los resultados,
- comparación justa contra baselines,
- limitaciones estadísticas,
- uso correcto de términos como “óptimo”.

Evitar aceptar “óptimo” si el algoritmo es metaheurístico y no prueba optimalidad. Recomendar expresiones como:

- “mejor solución encontrada”,
- “ruta de menor costo hallada”,
- “solución aproximada”,
- “mejor configuración evaluada”.

#### Bibliografía

Verificar:

- pertinencia de fuentes,
- formato homogéneo,
- citas dentro del texto,
- correspondencia entre referencias listadas y usadas,
- referencias clave del área.

#### Estilo y formalidad académica

Observar:

- tono académico,
- errores de acentuación o puntuación,
- frases largas,
- términos informales,
- mezcla innecesaria de inglés y español,
- símbolos no definidos,
- títulos/captions de tablas y figuras.

## Evaluar código y reproducibilidad

Cuando el usuario pida evaluar el proyecto completo, inspeccionar también:

- si el código implementa lo que el informe afirma,
- si hay scripts para reproducir experimentos,
- si los resultados del informe corresponden a archivos generados,
- si las dependencias son instalables,
- si el README explica instalación/ejecución/reproducción,
- si hay tests o validaciones mínimas,
- si hay problemas obvios de aleatoriedad, semillas o no determinismo,
- si se mezclan unidades o escalas sin justificar.

No sobredimensionar críticas de ingeniería si la consigna era principalmente académica, pero señalar problemas que afecten la reproducibilidad o validez de resultados.

## Evaluar GitHub/proceso

Cuando sea relevante, revisar con `gh`:

- issues creados,
- si tienen descripción, subtareas, comentarios y cierre coherente,
- PRs y ramas,
- commits directos a `main`,
- participación de integrantes,
- trazabilidad entre issues, commits y resultados.

La evaluación debe diferenciar:

- ausencia de evidencia,
- incumplimiento claro,
- cumplimiento parcial,
- no verificable por permisos o falta de acceso.

## Formatos de salida recomendados

### Resumen ejecutivo

Usar cuando el usuario quiera una evaluación general:

```markdown
## Veredicto general

**Cumplimiento:** Cumple / Cumple parcialmente / No cumple estrictamente.

- Fortalezas principales:
  - ...
- Problemas principales:
  - ...
- Recomendación:
  - Aprobable / Aprobable con correcciones / Requiere revisión importante.
```

### Checklist de cumplimiento

```markdown
| Requisito | Estado | Evidencia |
|---|---:|---|
| Informe Markdown en ruta solicitada | Parcial | Existe `informe.md`, no `proyecto_final/proyecto_final.md`. |
```

### Revisión por dimensiones

```markdown
## Informe
## Materiales y métodos
## Resultados
## Código y reproducibilidad
## GitHub/proceso
## Recomendaciones prioritarias
```

### Issues agrupados

Cuando el usuario pida subir sugerencias a GitHub, preferir pocos issues amplios. Para informes similares, usar 5 issues:

1. **Ajustar estructura del informe final**
   - mover/renombrar a la ruta pedida,
   - agregar análisis y discusión,
   - separar resultados, interpretación y limitaciones.

2. **Fortalecer marco teórico y bibliografía**
   - agregar citas en cuerpo,
   - referenciar conceptos principales,
   - aclarar diferencias entre modelos,
   - homogeneizar referencias.

3. **Completar materiales y métodos**
   - describir datos,
   - aclarar generación de ventanas/demandas/capacidad/jornada,
   - detallar procedimiento experimental,
   - incluir tabla de parámetros y barrido,
   - definir métricas y baselines.

4. **Profundizar resultados y discusión**
   - aclarar unidades y métricas,
   - agregar dispersión: desviación estándar, IQR o rango mínimo/máximo,
   - interpretar gráficos,
   - explicar selección de “Best ACO”,
   - reemplazar “óptimo” por “mejor solución encontrada” cuando corresponda.

5. **Revisar redacción y formalidad académica**
   - corregir acentuación y puntuación,
   - evitar expresiones informales,
   - homogeneizar idioma y nombres de parámetros,
   - revisar tablas/figuras,
   - explicar símbolos y figuras.

Usar labels existentes si no se pueden crear nuevas. Preferir `documentation` para mejoras de informe.

## Tono sugerido

- En español si el proyecto/usuario está en español.
- Conciso si el usuario pide issues o resumen.
- Detallado si pide análisis exhaustivo.
- Evitar sonar punitivo: indicar “cumple parcialmente” y “recomendaciones” con evidencia.
- No hacer cambios en repositorios de estudiantes salvo pedido explícito del usuario.
