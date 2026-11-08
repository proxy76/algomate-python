export interface FileEntry {
  id: string;
  name: string;
  content: string;
}

export interface Workspace {
  files: FileEntry[];
  activeId: string;
}

export const ENTRY = "main.py";
export const MAX_FILES = 20;
const KEY = "algomate-python:workspace";
const BACKUP_KEY = "algomate-python:workspace-backup";

export const FILE_NAME_RE = /^(?!.*\.\.)[A-Za-z0-9_\-.]{1,60}$/;

export const newId = () => Math.random().toString(36).slice(2, 10);

export function makeWorkspace(files: { name: string; content: string }[]): Workspace {
  const entries = files.map((f) => ({ id: newId(), name: f.name, content: f.content }));
  // main.py always comes first.
  entries.sort((a, b) => (a.name === ENTRY ? -1 : b.name === ENTRY ? 1 : 0));
  if (!entries.some((f) => f.name === ENTRY)) entries.unshift({ id: newId(), name: ENTRY, content: "" });
  return { files: entries, activeId: entries[0].id };
}

export const STARTER = `# Bine ai venit pe AlgoMate Python!
# Scrie cod aici și apasă Ctrl + Enter (sau butonul Rulează).

nume = input("Cum te numești? ")
print(f"Salut, {nume}! Iată primele 5 pătrate perfecte:")

for i in range(1, 6):
    print(f"{i} × {i} = {i * i}")
`;

export function loadWorkspace(): Workspace {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && Array.isArray(raw.files) && raw.files.length) {
      const ws = raw as Workspace;
      if (!ws.files.some((f) => f.id === ws.activeId)) ws.activeId = ws.files[0].id;
      return ws;
    }
  } catch {
    /* fall through */
  }
  return makeWorkspace([{ name: ENTRY, content: STARTER }]);
}

export function saveWorkspace(ws: Workspace): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ws));
  } catch {
    /* quota or private mode */
  }
}

export function backupWorkspace(ws: Workspace): void {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify(ws));
  } catch {
    /* ignore */
  }
}

export function loadBackup(): Workspace | null {
  try {
    return JSON.parse(localStorage.getItem(BACKUP_KEY) || "null");
  } catch {
    return null;
  }
}

export interface Example {
  id: string;
  title: { ro: string; en: string };
  files: { name: string; content: string }[];
}

export const EXAMPLES: Example[] = [
  {
    id: "salut",
    title: { ro: "Salut — citire de la tastatură", en: "Hello — reading input" },
    files: [{ name: ENTRY, content: STARTER }],
  },
  {
    id: "cifre",
    title: { ro: "Suma și numărul cifrelor", en: "Sum and count of digits" },
    files: [
      {
        name: ENTRY,
        content: `n = int(input("n = "))

suma, nr = 0, 0
copie = n
while copie > 0:
    suma += copie % 10
    nr += 1
    copie //= 10

print(f"{n} are {nr} cifre, cu suma {suma}")
`,
      },
    ],
  },
  {
    id: "ciur",
    title: { ro: "Ciurul lui Eratostene", en: "Sieve of Eratosthenes" },
    files: [
      {
        name: ENTRY,
        content: `def ciur(n):
    """Întoarce lista numerelor prime <= n."""
    prim = [True] * (n + 1)
    prim[0] = prim[1] = False
    for i in range(2, int(n ** 0.5) + 1):
        if prim[i]:
            for j in range(i * i, n + 1, i):
                prim[j] = False
    return [i for i, p in enumerate(prim) if p]


n = int(input("Până la ce număr? "))
prime = ciur(n)
print(f"Sunt {len(prime)} numere prime până la {n}:")
print(*prime)
`,
      },
    ],
  },
  {
    id: "fisiere",
    title: { ro: "Fișiere: date.in → date.out", en: "Files: date.in → date.out" },
    files: [
      {
        name: ENTRY,
        content: `# Citim numerele din date.in (vezi tab-ul de sus),
# scriem rezultatul în date.out, apoi îl afișăm.

with open("date.in") as f:
    n = int(f.readline())
    v = list(map(int, f.readline().split()))

pare = [x for x in v if x % 2 == 0]

with open("date.out", "w") as g:
    g.write(" ".join(map(str, sorted(pare))) + "\\n")

print("Am scris în date.out:")
print(open("date.out").read())
`,
      },
      { name: "date.in", content: "8\n12 7 4 19 30 3 8 15\n" },
    ],
  },
  {
    id: "recursiv",
    title: { ro: "Fibonacci recursiv cu memoizare", en: "Memoized recursive Fibonacci" },
    files: [
      {
        name: ENTRY,
        content: `from functools import lru_cache


@lru_cache(maxsize=None)
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


for i in range(0, 101, 10):
    print(f"fib({i:3}) = {fib(i)}")
`,
      },
    ],
  },
  {
    id: "module",
    title: { ro: "Program pe mai multe fișiere", en: "Multi-file program" },
    files: [
      {
        name: ENTRY,
        content: `from geometrie import arie_cerc, distanta

r = float(input("Raza cercului: "))
print(f"Aria: {arie_cerc(r):.3f}")

print("Distanța de la (0, 0) la (3, 4):", distanta((0, 0), (3, 4)))
`,
      },
      {
        name: "geometrie.py",
        content: `import math


def arie_cerc(r):
    return math.pi * r * r


def distanta(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])
`,
      },
    ],
  },
  {
    id: "sortare",
    title: { ro: "Sortare prin selecție, pas cu pas", en: "Selection sort, step by step" },
    files: [
      {
        name: ENTRY,
        content: `v = [29, 10, 14, 37, 13, 5, 22]
print("Inițial:", v)

for i in range(len(v) - 1):
    m = i
    for j in range(i + 1, len(v)):
        if v[j] < v[m]:
            m = j
    v[i], v[m] = v[m], v[i]
    print(f"Pasul {i + 1}:", v)

print("Sortat: ", v)
`,
      },
    ],
  },
  {
    id: "eroare",
    title: { ro: "Citește o eroare (traceback)", en: "Reading an error (traceback)" },
    files: [
      {
        name: ENTRY,
        content: `# Rulează și apasă pe „line ...” din consolă ca să sari la linia cu problema.

def medie(lista):
    return sum(lista) / len(lista)


print(medie([10, 9, 8]))
print(medie([]))  # împărțire la zero!
`,
      },
    ],
  },
];
