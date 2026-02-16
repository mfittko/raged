{{- define "raged.name" -}}raged{{- end -}}
{{- define "raged.labels" -}}
app.kubernetes.io/name: {{ include "raged.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
