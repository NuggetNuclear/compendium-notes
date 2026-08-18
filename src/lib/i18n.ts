export type Locale = 'es' | 'en';

export const translations = {
    // Nav
    'nav.app': { es: 'Abrir App', en: 'Open App' },
    'nav.config': { es: 'Configuración', en: 'Settings' },

    // Hero
    'hero.badge.nocloud': { es: 'Sin servidores', en: 'No cloud' },
    'hero.badge.opensource': { es: 'Open Source', en: 'Open Source' },
    'hero.title.prefix': { es: 'Convierte tus', en: 'Turn your' },
    'hero.title.suffix': { es: 'en apuntes perfectos', en: 'into perfect notes' },
    'hero.title.line1': { es: 'Convierte clases', en: 'Turn lectures' },
    'hero.title.line2': { es: 'en conocimiento', en: 'into knowledge' },
    'hero.subtitle': {
        es: 'Transcribe audio y video con IA totalmente gratis y sin límites. Convierte clases o reuniones en apuntes estructurados en Markdown y descárgalos en PDF listo para estudiar.',
        en: 'Transcribe audio and video with AI completely free and without limits. Turn lectures or meetings into structured Markdown notes and download them as study-ready PDFs.',
    },
    'hero.cta.start': { es: 'Comenzar gratis', en: 'Start for free' },
    'hero.cta.how': { es: 'Ver cómo funciona', en: 'See how it works' },

    // Features
    'features.label': { es: 'Características', en: 'Features' },
    'features.title': { es: 'Todo lo que necesitas', en: 'Everything you need' },
    'features.subtitle': {
        es: 'De audio/video a apuntes profesionales en minutos.',
        en: 'From audio/video to professional notes in minutes.',
    },
    'features.transcribe.title': { es: 'Transcripción Dual', en: 'Dual Transcription' },
    'features.transcribe.desc': {
        es: 'Elige entre la velocidad extrema de Whisper + GPT-OSS (Groq) o el razonamiento del ecosistema Gemini con 3.5 Flash Lite y 3.1 Flash Lite.',
        en: 'Choose between Whisper + GPT-OSS extreme speed (Groq) or Gemini ecosystem reasoning with 3.5 Flash Lite and 3.1 Flash Lite.',
    },
    'features.organize.title': { es: 'Organización Inteligente', en: 'Intelligent Organization' },
    'features.organize.desc': {
        es: 'Detecta temas automáticamente, extrae conceptos clave y genera resúmenes estructurados perfectos.',
        en: 'Automatically detects topics, extracts key concepts, and generates structured perfect summaries.',
    },
    'features.export.title': { es: 'Exportación Premium', en: 'Premium Export' },
    'features.export.desc': {
        es: 'Obtén documentos PDF limpios, paginados y con formato académico listos para imprimir o estudiar.',
        en: 'Get clean, paginated, and academically formatted PDF documents ready to print or study.',
    },
    'features.privacy.title': { es: 'Privacidad Total', en: 'Total Privacy' },
    'features.privacy.desc': {
        es: 'Tus datos nunca pasan por nuestros servidores. Todo se procesa en tu navegador con tu propia API Key.',
        en: 'Your data never goes through our servers. Everything is processed in your browser with your own API Key.',
    },
    'features.multiformat.title': { es: 'Multi-formato', en: 'Multi-format' },
    'features.multiformat.desc': {
        es: 'Soporta MP3, MP4, WAV, M4A, WEBM, FLAC, MOV y más. Audio y video sin límites.',
        en: 'Supports MP3, MP4, WAV, M4A, WEBM, FLAC, MOV and more. Audio and video without limits.',
    },
    'features.speed.title': { es: 'Ultra-rápido', en: 'Ultra-fast' },
    'features.speed.desc': {
        es: 'Procesamiento en segundos gracias a infraestructura de IA de última generación.',
        en: 'Processing in seconds thanks to state-of-the-art AI infrastructure.',
    },

    // How it works
    'how.label': { es: 'Proceso', en: 'Process' },
    'how.title': { es: 'Así de simple', en: 'Simple as that' },
    'how.step1.title': { es: 'Elige tu IA', en: 'Choose your AI' },
    'how.step1.desc': {
        es: 'Usa una API Key gratuita de Groq o Google Gemini.',
        en: 'Use a free Groq or Google Gemini API Key.',
    },
    'how.step2.title': { es: 'Sube tu archivo', en: 'Upload your file' },
    'how.step2.desc': {
        es: 'Arrastra tu grabación. MP3, MP4, WAV y más.',
        en: 'Drag your recording. MP3, MP4, WAV and more.',
    },
    'how.step3.title': { es: 'La IA organiza', en: 'AI organizes' },
    'how.step3.desc': {
        es: 'Transcripción y organización automática con IA.',
        en: 'Automatic transcription and organization with AI.',
    },
    'how.step4.title': { es: 'Descarga PDF', en: 'Download PDF' },
    'how.step4.desc': {
        es: 'Edita y descarga un PDF profesional.',
        en: 'Edit and download a professional PDF.',
    },

    // Pricing
    'pricing.label': { es: 'Precio', en: 'Pricing' },
    'pricing.title': { es: 'Elige tu Motor', en: 'Choose your Engine' },
    'pricing.subtitle': {
        es: 'Ambas opciones son gratuitas con tu propia API Key. Tú tienes el control.',
        en: 'Both options are free with your own API Key. You are in control.',
    },

    // Groq Card
    'pricing.groq.title': { es: 'Velocidad', en: 'Speed' },
    'pricing.groq.desc': { es: 'Ideal para clases estándar (Whisper + GPT-OSS)', en: 'Ideal for standard classes (Whisper + GPT-OSS)' },
    'pricing.groq.price': { es: '$0', en: '$0' },
    'pricing.groq.f1': { es: 'Modelo Whisper V3 Turbo + Llama', en: 'Whisper V3 Turbo + Llama Model' },
    'pricing.groq.f2': { es: 'Transcripción ultra-rápida', en: 'Ultra-fast transcription' },
    'pricing.groq.f3': { es: 'Mejor para audios < 45 minutos', en: 'Best for audios < 45 minutes' },
    'pricing.groq.btn': { es: 'Obtener Key de Groq', en: 'Get Groq Key' },

    // Gemini Card
    'pricing.gemini.title': { es: 'Potencia', en: 'Power' },
    'pricing.gemini.desc': { es: 'Para contenido complejo', en: 'For complex content' },
    'pricing.gemini.price': { es: '$0', en: '$0' },
    'pricing.gemini.f1': { es: 'Modelo Gemini 3.5 Flash Lite + 3.1 Flash Lite', en: 'Gemini 3.5 Flash Lite + 3.1 Flash Lite Models' },
    'pricing.gemini.f2': { es: 'Contexto masivo (+45min)', en: 'Massive context (+45min)' },
    'pricing.gemini.f3': { es: 'Razonamiento multimodal', en: 'Multimodal reasoning' },
    'pricing.gemini.btn': { es: 'Obtener Key de Gemini', en: 'Get Gemini Key' },

    // Notifications
    'notif.done': { es: 'Resumen generado', en: 'Summary generated' },
    'notif.compressing': { es: 'Preparando audio...', en: 'Preparing audio...' },
    'notif.uploading': { es: 'Subiendo...', en: 'Uploading...' },
    'notif.transcribing': { es: 'Transcribiendo...', en: 'Transcribing...' },
    'notif.analyzing': { es: 'Generando notas...', en: 'Generating notes...' },
    'notif.processing': { es: 'Procesando...', en: 'Processing...' },
    'notif.click_view': { es: 'Click para ver resultados', en: 'Click to view results' },
    'notif.error': { es: 'Error en el proceso', en: 'Process failed' },
    'notif.click_detail': { es: 'Click para ver el detalle', en: 'Click to see details' },
    'notif.audio_extracted': { es: 'Audio extraído', en: 'Audio extracted' },
    'notif.audio_optimized': { es: 'Audio optimizado', en: 'Audio optimized' },
    'notif.fragments': { es: 'fragmentos', en: 'fragments' },
    'notif.chunks': { es: 'fragmentos', en: 'chunks' },

    'pricing.cta.start': { es: 'Comenzar ahora', en: 'Start now' },
    'pricing.cta.key': { es: 'Obtener API Key', en: 'Get API Key' },

    // Footer
    'footer.tagline': { es: 'Transforma cualquier audio o video en documentos estructurados con inteligencia artificial.', en: 'Transform any audio or video into structured documents with artificial intelligence.' },
    'footer.madewith': { es: 'Hecho con', en: 'Made with' },
    'footer.product': { es: 'Producto', en: 'Product' },
    'footer.resources': { es: 'Recursos', en: 'Resources' },
    'footer.legal': { es: 'Legal', en: 'Legal' },
    'footer.features': { es: 'Características', en: 'Features' },
    'footer.pricing': { es: 'Precios', en: 'Pricing' },
    'footer.docs': { es: 'Documentación', en: 'Documentation' },
    'footer.groq': { es: 'Consola Groq', en: 'Groq Console' },
    'footer.gemini': { es: 'Consola Gemini', en: 'Gemini Console' },
    'footer.github': { es: 'GitHub', en: 'GitHub' },
    'footer.privacy': { es: 'Privacidad', en: 'Privacy' },
    'footer.terms': { es: 'Términos', en: 'Terms' },
    'footer.ai_disclaimer': {
        es: 'La IA puede cometer errores. Verifica la información importante.',
        en: 'AI can make mistakes. Please verify important information.',
    },
    'footer.copyright': { es: 'Compendium. Todos los derechos reservados.', en: 'Compendium. All rights reserved.' },

    // Hero Preview
    'hero.preview.filename': { es: 'clase_calculo.mp3', en: 'calculus_class.mp3' },
    'hero.preview.status': { es: 'Completado', en: 'Completed' },
    'hero.preview.summary': { es: 'Resumen', en: 'Summary' },
    'hero.preview.summary.val': { es: '5 puntos clave', en: '5 key points' },
    'hero.preview.concepts': { es: 'Conceptos', en: 'Concepts' },
    'hero.preview.concepts.val': { es: '12 términos', en: '12 terms' },
    'hero.preview.pdf': { es: 'PDF', en: 'PDF' },
    'hero.preview.pdf.val': { es: '8 páginas', en: '8 pages' },

    // App
    'app.upload.title': { es: 'Sube tu archivo', en: 'Upload your file' },
    'app.upload.subtitle': {
        es: 'Arrastra tu grabación (Audio/Video).',
        en: 'Drag your recording (Audio/Video).',
    },
    'app.upload.drop': { es: 'Arrastra tu archivo o haz click', en: 'Drag your file or click' },
    'app.upload.dropping': { es: 'Suelta tu archivo aquí', en: 'Drop your file here' },
    'app.upload.formats': { es: 'MP3, MP4, WAV, M4A, MOV — Máx. 250MB', en: 'MP3, MP4, WAV, M4A, MOV — Max. 250MB' },
    'app.upload.select': { es: 'Seleccionar archivo', en: 'Select file' },
    'app.upload.transcribe': { es: 'Transcribir con IA', en: 'Transcribe with AI' },
    'app.upload.remove': { es: 'Eliminar archivo', en: 'Remove file' },
    'app.record.start': { es: 'Grabar Audio', en: 'Record Audio' },
    'app.record.stop': { es: 'Detener', en: 'Stop' },
    'app.record.recording': { es: 'Grabando', en: 'Recording' },
    'app.record.cancel': { es: 'Cancelar', en: 'Cancel' },
    'app.record.paused': { es: 'En pausa', en: 'Paused' },
    'app.record.resume': { es: 'Reanudar', en: 'Resume' },
    'app.record.review': { es: 'Revisar grabación', en: 'Review recording' },
    'app.record.use': { es: 'Usar grabación', en: 'Use recording' },
    'app.record.discard': { es: 'Descartar', en: 'Discard' },
    'app.record.denied': { es: 'Permiso de micrófono denegado', en: 'Microphone permission denied' },
    'app.record.retry': { es: 'Reintentar', en: 'Retry' },
    'app.record.download': { es: 'Descargar', en: 'Download' },
    'app.summary.level': { es: 'Nivel de resumen', en: 'Summary level' },
    'app.summary.short': { es: 'Corto', en: 'Short' },
    'app.summary.medium': { es: 'Mediano', en: 'Medium' },
    'app.summary.long': { es: 'Detallado', en: 'Detailed' },
    'app.summary.short.desc': { es: 'Resumen rápido y conceptos clave', en: 'Quick summary and key concepts' },
    'app.summary.medium.desc': { es: 'Resumen balanceado con secciones', en: 'Balanced summary with sections' },
    'app.summary.long.desc': { es: 'Documento exhaustivo y completo', en: 'Comprehensive and exhaustive document' },
    'app.lang.output': { es: 'Idioma de salida', en: 'Output language' },
    'app.lang.auto': { es: 'Auto (Original)', en: 'Auto (Original)' },
    'app.lang.auto.desc': { es: 'Mismo idioma que el audio', en: 'Same as audio language' },
    'app.lang.es': { es: 'Español', en: 'Spanish' },
    'app.lang.en': { es: 'Inglés', en: 'English' },
    'app.lang.fr': { es: 'Francés', en: 'French' },
    'app.lang.de': { es: 'Alemán', en: 'German' },
    'app.lang.it': { es: 'Italiano', en: 'Italian' },
    'app.lang.pt': { es: 'Portugués', en: 'Portuguese' },
    'app.editor.resummarize': { es: 'Re-resumir', en: 'Re-summarize' },
    'app.editor.resummarizing': { es: 'Re-resumiendo...', en: 'Re-summarizing...' },
    'app.editor.words': { es: 'palabras', en: 'words' },
    'app.editor.reading': { es: 'min lectura', en: 'min read' },
    'app.editor.sections': { es: 'secciones', en: 'sections' },
    'app.transcribing': { es: 'Transcribiendo...', en: 'Transcribing...' },
    'app.transcribing.desc': {
        es: 'Procesando audio rápido con Whisper + Llama 3',
        en: 'Fast audio processing with Whisper + Llama 3',
    },
    'app.ai.title': { es: 'Organizando con IA', en: 'Organizing with AI' },
    'app.ai.desc': {
        es: 'Llama 3 está creando tus apuntes',
        en: 'Llama 3 is creating your notes',
    },
    'app.ai.step1': { es: 'Analizando contenido...', en: 'Analyzing content...' },
    'app.ai.step2': { es: 'Extrayendo conceptos clave...', en: 'Extracting key concepts...' },
    'app.ai.step3': { es: 'Generando resumen...', en: 'Generating summary...' },
    'app.ai.step4': { es: 'Estructurando documento...', en: 'Structuring document...' },
    'app.ai.step5': { es: 'Listo', en: 'Done' },
    'app.editor.markdown': { es: 'Editor Markdown', en: 'Markdown Editor' },
    'app.editor.preview': { es: 'Vista previa', en: 'Preview' },
    'app.editor.new': { es: 'Nuevo', en: 'New' },
    'app.editor.start_new': { es: 'Crear nuevo documento', en: 'Create new document' },
    'app.editor.copy': { es: 'Copiar', en: 'Copy' },
    'app.editor.copied': { es: 'Copiado', en: 'Copied' },
    'app.editor.download': { es: 'Descargar PDF', en: 'Download PDF' },
    'app.editor.downloading': { es: 'Generando...', en: 'Generating...' },
    'app.editor.downloaded': { es: 'Descargado', en: 'Downloaded' },
    'app.config.title': { es: 'Configuración', en: 'Settings' },
    'app.config.apikey': { es: 'Groq API Key', en: 'Groq API Key' },
    'app.config.show': { es: 'Mostrar', en: 'Show' },
    'app.config.hide': { es: 'Ocultar', en: 'Hide' },
    'app.config.paste': { es: 'Pegar', en: 'Paste' },
    'app.config.save': { es: 'Guardar', en: 'Save' },
    'app.config.saved': { es: 'Guardada', en: 'Saved' },
    'app.config.verifying': { es: 'Verificando...', en: 'Verifying...' },
    'app.config.processing': { es: 'Procesando archivo...', en: 'Processing file...' },
    'app.config.new_key': { es: 'Ingresar una nueva API key', en: 'Enter a new API key' },
    'app.config.active_encrypted': { es: 'Activa y Encriptada', en: 'Active and Encrypted' },
    'app.config.clear': { es: 'Eliminar', en: 'Delete' },
    'app.config.valid_format': { es: 'Formato válido', en: 'Valid format' },
    'app.config.invalid_format_groq': { es: 'Debe empezar con gsk_', en: 'Must start with gsk_' },
    'app.config.invalid_format_gemini': { es: 'Debe empezar con AI', en: 'Must start with AI' },
    'app.config.format_label': { es: 'Formato:', en: 'Format:' },
    'app.config.error.groq': { es: 'La API Key de Groq no es válida o no tiene créditos/acceso.', en: 'Groq API Key is invalid or has no credits/access.' },
    'app.config.error.gemini': { es: 'La API Key de Gemini no es válida.', en: 'Gemini API Key is invalid.' },
    'app.config.error.network': { es: 'Error al validar las llaves via red.', en: 'Error validating keys via network.' },
    'app.config.privacy': {
        es: 'Tu API key se guarda solo en tu navegador. Nunca la enviamos a ningún servidor.',
        en: 'Your API key is stored only in your browser. We never send it to any server.',
    },
    'app.config.howto': { es: '¿Cómo obtener mi API key?', en: 'How to get my API key?' },
    'app.config.pdfstyle': { es: 'Estilo de PDF', en: 'PDF Style' },
    'app.config.provider': { es: 'Proveedor de IA', en: 'AI Provider' },
    'app.config.transcription_model': { es: 'Modelo de transcripción', en: 'Transcription Model' },
    'app.config.transcription_model.desc': {
        es: 'Auto empieza por el primero y cambia solo si falla. Con uno fijo, se intenta ese primero.',
        en: 'Auto starts with the first one and switches only if it fails. A fixed model is simply tried first.'
    },
    'app.config.groq.get': { es: 'Obtener API Key de Groq', en: 'Get Groq API Key' },
    'app.config.gemini.get': { es: 'Obtener API Key de Gemini', en: 'Get Gemini API Key' },
    'app.config.close': { es: 'Cerrar', en: 'Close' },
    'app.style.minimalista': { es: 'Minimalista', en: 'Minimalist' },
    'app.style.academico': { es: 'Académico', en: 'Academic' },
    'app.style.cornell': { es: 'Cornell', en: 'Cornell' },
    'app.connected': { es: 'Conectada', en: 'Connected' },
    'app.cancel': { es: 'Cancelar', en: 'Cancel' },
    'app.processing': { es: 'Procesando', en: 'Processing' },
    'app.error.apikey': {
        es: 'Configura tu API Key (Groq o Gemini) primero.',
        en: 'Configure your API Key (Groq or Gemini) first.',
    },
    'app.processing.patience': {
        es: 'Se paciente, la duración depende de la potencia de tu dispositivo y el tamaño del archivo.',
        en: 'Please be patient, duration depends on your device power and file size.',
    },
    'app.processing.patience.gemini': {
        es: 'La transcripción y análisis están en curso. En archivos de larga duración, este proceso puede demorar unos minutos.',
        en: 'Transcription and analysis are in progress. For long files, this process can take a few minutes.',
    },
    'app.processing.cancel': { es: 'Cancelar transcripción', en: 'Cancel transcription' },
    'app.processing.stuck_btn': { es: 'Limpiar proceso atascado', en: 'Clear stuck process' },
    'app.processing.reset_desc': { es: '¿Se quedó pegado?', en: 'Stuck?' },

    // Privacy
    'privacy.title': { es: 'Política de Privacidad', en: 'Privacy Policy' },
    'privacy.date': { es: 'Última actualización: 23 de marzo de 2026', en: 'Last updated: March 23, 2026' },
    'privacy.intro.title': { es: '1. Introducción', en: '1. Introduction' },
    'privacy.intro.desc': {
        es: 'Compendium ("nosotros", "nuestro") respeta profundamente la privacidad de nuestros usuarios y entendemos la alta sensibilidad de la información procesada. Esta Política de Privacidad describe nuestras prácticas sobre la recopilación y manejo de información. Operamos bajo un principio estricto de cliente-servidor descentralizado, a menudo referido como <strong>Bring Your Own Key (BYOK)</strong>. Sus audios, textos y claves API nunca son almacenados en nuestros servidores, siendo delegados enteramente a funciones ejecutadas en su propio dispositivo o a través de conductos seguros directos a los proveedores de inteligencia artificial establecidos (Google o Groq) utilizando sus propios medios de acceso.',
        en: 'Compendium ("we", "our") deeply respects our user\'s privacy and we understand the high sensitivity of the processed information. This Privacy Policy describes our practices regarding information collection and handling. We operate under a strict decentralized client-server principle, often referred to as <strong>Bring Your Own Key (BYOK)</strong>. Your audios, texts, and API keys are never stored on our servers, being entirely delegated to functions running on your own device or through direct secure conduits to established AI providers (Google or Groq) using your own access means.'
    },
    'privacy.collection.title': { es: '2. Recopilación de Datos', en: '2. Data Collection' },
    'privacy.collection.desc': {
        es: 'No almacenamos sus archivos de audio ni las transcripciones en nuestros servidores. Todo el procesamiento ocurre en su navegador o se envía directamente desde su navegador a las APIs de Groq o Google utilizando su propia API Key.',
        en: 'We do not store your audio files or transcripts on our servers. All processing happens in your browser or is sent directly from your browser to Groq or Google APIs using your own API Key.'
    },
    'privacy.collection.l1': { es: 'API Keys: Se almacenan localmente en su dispositivo (localStorage). Nunca se envían a nuestros servidores.', en: 'API Keys: Stored locally on your device (localStorage). Never sent to our servers.' },
    'privacy.collection.l2': { es: 'Archivos de Audio: Se procesan temporalmente en su navegador para su reproducción y envío a las APIs.', en: 'Audio Files: Processed temporarily in your browser for playback and API transmission.' },
    'privacy.collection.l3': { es: 'Transcripciones y Notas: Se generan y muestran en su navegador. Usted es responsable de guardarlas.', en: 'Transcripts and Notes: Generated and displayed in your browser. You are responsible for saving them.' },
    'privacy.third.title': { es: '3. Uso de Servicios de Terceros', en: '3. Third-Party Services' },
    'privacy.third.desc': {
        es: 'Al interactuar con nuestros canales de procesamiento, su entorno local establece comunicaciones cifradas asíncronas con plataformas de terceros para el análisis avanzado. Dado esto, la retención de dichos intercambios está circunscrita a las propias políticas corporativas de:',
        en: 'By interacting with our processing pipelines, your local environment establishes asynchronous encrypted communications with third-party platforms for advanced analysis. Thus, retention of such exchanges is bound to the corporate policies of:'
    },
    'privacy.changes.title': { es: '4. Cambios en esta Política', en: '4. Changes to this Policy' },
    'privacy.changes.desc': {
        es: 'Podemos actualizar nuestra Política de Privacidad de vez en cuando. Le notificaremos de cualquier cambio publicando la nueva política en esta página.',
        en: 'We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new policy on this page.'
    },
    'privacy.contact.title': { es: '5. Contacto', en: '5. Contact' },
    'privacy.contact.desc': {
        es: 'Si tiene preguntas sobre esta Política de Privacidad, por favor contáctenos a través de nuestro repositorio en GitHub.',
        en: 'If you have questions about this Privacy Policy, please contact us via our GitHub repository.'
    },
    'privacy.back': { es: 'Volver al inicio', en: 'Back to home' },

    // Terms
    'terms.title': { es: 'Términos de Servicio', en: 'Terms of Service' },
    'terms.date': { es: 'Última actualización: 23 de marzo de 2026', en: 'Last updated: March 23, 2026' },
    'terms.acceptance.title': { es: '1. Aceptación de los Términos', en: '1. Acceptance of Terms' },
    'terms.acceptance.desc': {
        es: 'Al acceder e interactuar con el ecosistema de Compendium, usted consiente sujetarse a los presentes lineamientos legales. La disconformidad parcial o total con este acuerdo innhabilita de manera irrevocable el uso lícito de la plataforma.',
        en: 'By accessing and interacting with the Compendium ecosystem, you consent to be bound by these legal guidelines. Partial or total disagreement with this agreement irrevocably disables the lawful use of the platform.'
    },
    'terms.desc.title': { es: '2. Descripción del Servicio', en: '2. Service Description' },
    'terms.desc.desc': {
        es: 'La plataforma consiste en una conjunción de procesadores de audio y herramientas de arquitectura de texto impulsadas por sistemas deterministas multimodales (Inteligencia Artificial). Suministramos las interfaces de acceso "tal cual" (AS IS), sin garantías tácitas de rendimiento ni disponibilidad perpetua.',
        en: 'The platform consists of a conjunction of audio processors and text architecture tools driven by multimodal deterministic systems (Artificial Intelligence). We provide access interfaces "AS IS", without implied warranties of performance or perpetual availability.'
    },
    'terms.resp.title': { es: '3. Responsabilidades del Usuario', en: '3. User Responsibilities' },
    'terms.resp.l1': { es: 'Acata salvaguardar la custodia sobre toda credencial (API key) ingresada. Nosotros no poseemos registro de sus accesos.', en: 'Comply with safeguarding custody over any entered credential (API key). We possess no logs of your accesses.' },
    'terms.resp.l2': { es: 'Declina la posibilidad de utilizar nuestras herramientas de transposición en actividades ilícitas que vulneren propiedad intelectual ajena.', en: 'Decline the possibility of using our transposition tools in illicit activities that violate collateral intellectual property.' },
    'terms.resp.l3': { es: 'Reafirma que actúa en derecho de propiedad, licencia, o consentimiento expreso al auditar cualquier fonograma subido a la aplicación.', en: 'Reaffirm acting in right of property, license, or express consent when auditing any phonogram uploaded to the application.' },
    'terms.costs.title': { es: '4. Transacciones, Costos y Tarifas', en: '4. Transactions, Costs and Fees' },
    'terms.costs.desc': {
        es: 'Compendium es una interfaz que distribuye las operaciones localmente careciendo de cuotas internas. Sin embargo, su conexión puente con motores de origen corporativo (Google Gemini, Groq) se circunscribe a los términos comerciales emitidos por tales. El usuario asume plena responsabilidad por topes de uso, saldos adeudados o cualquier cargo facturado por su proveedor de API respectivo.',
        en: 'Compendium is an interface that distributes operations locally, lacking internal quotas. Nevertheless, its bridge connection with corporate origin engines (Google Gemini, Groq) is subject to the commercial terms issued by them. The user assumes full liability for usage caps, due balances or any charged bill invoiced by their respective API provider.'
    },
    'terms.limit.title': { es: '5. Limitación de Responsabilidad', en: '5. Limitation of Liability' },
    'terms.limit.desc': {
        es: 'Los creadores de Compendium se eximen explícitamente de indemnizar o restaurar a ninguna parte involucrada ante menoscabos o pérdidas punitivas producidas directa o tangencialmente por percances que el uso de la propia plataforma pueda originar, fallas en la IA o alteración sobre los dispositivos implementados.',
        en: 'Compendium creators explicitly waive any indemnification or restitution to any involved party over punitive damages or losses produced directly or tangentially by mishaps that the use of the platform itself might originate, AI failures or device alteration.'
    },
    'terms.mod.title': { es: '6. Modificaciones', en: '6. Modifications' },
    'terms.mod.desc': {
        es: 'Nos reservamos el derecho de modificar o reemplazar estos Términos en cualquier momento. Es su responsabilidad revisar estos Términos periódicamente para ver si hay cambios.',
        en: 'We reserve the right to modify or replace these Terms at any time. It is your responsibility to review these Terms periodically for changes.'
    },

    // PDF
    'pdf.page': { es: 'Página', en: 'Page' },
    'pdf.of': { es: 'de', en: 'of' },

    // Language toggle
    'lang.switch': { es: 'EN', en: 'ES' },
} as const;

type TranslationKey = keyof typeof translations;

export function t(key: TranslationKey, locale: Locale): string {
    return translations[key]?.[locale] ?? key;
}

export function getLocaleFromBrowser(): Locale {
    if (typeof window === 'undefined') return 'es';
    const stored = localStorage.getItem('scn-lang');
    if (stored === 'en' || stored === 'es') return stored;
    return navigator.language.startsWith('en') ? 'en' : 'es';
}

export function setLocale(locale: Locale): void {
    if (typeof window !== 'undefined') {
        localStorage.setItem('scn-lang', locale);
    }
}
