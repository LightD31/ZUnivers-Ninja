import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

export function CopyButton({
  text,
  label,
  className = '',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`btn-ghost px-2 py-1.5 whitespace-nowrap ${className}`}
      title={copied ? 'Copié !' : 'Copier'}
      aria-label={label ?? 'Copier la commande'}
      onClick={async () => {
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-4 text-zu-400" /> : <Copy className="size-4" />}
      {label && <span>{copied ? 'Copié !' : label}</span>}
    </button>
  );
}
