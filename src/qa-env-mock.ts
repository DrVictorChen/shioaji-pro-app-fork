const q = new URLSearchParams(location.search);
const dir = '/Users/demo/Downloads';
const files: Record<string, string> = {
    '.env': 'SJ_API_KEY=DEMO_A\nSJ_SEC_KEY=DEMO_B\n',
    's_multi.env': 'SJ_API_KEY=DEMO_C\nSJ_SEC_KEY=DEMO_D\n',
    'yvictor.env': 'SJ_API_KEY=DEMO_E\nSJ_SEC_KEY=DEMO_F\n',
    'README.md': '#',
};
const only = q.get('files')?.split(',');
(window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    transformCallback: () => 0,
    invoke: async (cmd: string, args: any) => {
        if (cmd === 'plugin:dialog|open') return args.options.directory ? dir : `${dir}/${q.get('pick') ?? 's_multi.env'}`;
        if (cmd === 'plugin:fs|read_dir') return Object.keys(files).filter(n => !only || only.includes(n)).map(name => ({ name, isFile: true, isDirectory: false, isSymlink: false }));
        if (cmd === 'plugin:fs|read_text_file') { const n = String(args.path).split('/').pop()!; if (!(n in files)) throw new Error('nf'); return Array.from(new TextEncoder().encode(files[n]!)); }
        return null;
    },
};
