import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface UrlFormProps {
  initialUrl: string
  onSubmit: (url: string) => void
}

/** Stream URL input. Accepts master or media playlists; hls.js figures out which. */
export function UrlForm({ initialUrl, onSubmit }: UrlFormProps) {
  const [value, setValue] = useState(initialUrl)
  return (
    <form
      className="flex w-full gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        const url = value.trim()
        if (url) onSubmit(url)
      }}
    >
      <Input
        type="url"
        required
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="https://example.com/stream/master.m3u8"
        aria-label="Playlist URL (master or media)"
        className="font-mono text-xs"
      />
      <Button type="submit">Monitor</Button>
    </form>
  )
}
