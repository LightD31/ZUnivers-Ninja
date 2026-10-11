import { LoaderCircle, Search } from 'lucide-react';
import { useState } from 'react';

interface Props {
  initial?: string;
  loading: boolean;
  onSearch: (user: string) => void;
  size?: 'lg' | 'md';
}

export function SearchForm({ initial = '', loading, onSearch, size = 'md' }: Props) {
  const [value, setValue] = useState(initial);
  const large = size === 'lg';
  return (
    <form
      className="flex w-full gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const user = value.trim();
        if (user) onSearch(user);
      }}
    >
      <label className="relative flex-1">
        <span className="sr-only">Pseudo Discord</span>
        <Search
          className={`pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-white/60 ${large ? 'size-5' : 'size-4'}`}
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Pseudo Discord (ex : alexpresso)"
          autoComplete="off"
          spellCheck={false}
          className={`field w-full pr-3 ${large ? 'h-13 pl-11 text-base' : 'h-10 pl-10 text-sm'}`}
        />
      </label>
      <button
        type="submit"
        className={`btn-primary ${large ? 'h-13 px-5 text-base' : 'h-10'}`}
        disabled={loading || !value.trim()}
      >
        {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
        Conseiller
      </button>
    </form>
  );
}
