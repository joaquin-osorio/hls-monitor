/** Saves `text` as a file through a temporary object URL and a synthetic `<a download>` click. */
export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // Revoke on the next task: some browsers start the download asynchronously after the click.
  setTimeout(() => URL.revokeObjectURL(url))
}
