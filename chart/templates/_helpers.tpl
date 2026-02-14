{{- define "rag.name" -}}rag-stack{{- end -}}
{{- define "rag.labels" -}}
app.kubernetes.io/name: {{ include "rag.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
