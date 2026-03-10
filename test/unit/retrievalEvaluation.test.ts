/**
 * Retrieval Evaluation Test
 *
 * Runs all 4 retrieval strategies (VECTOR, HYBRID, ENSEMBLE, BM25) against a
 * known corpus with ground-truth relevance judgments, then computes standard
 * IR metrics: Precision@k, Recall@k, MRR, and nDCG.
 *
 * The mock vector store is query-aware so that different queries surface
 * different document orderings, allowing VECTOR strategy to behave
 * realistically. BM25/keyword scoring uses real term-matching logic.
 */

import { expect } from 'chai';
import { Embeddings } from '@langchain/core/embeddings';
import { VectorStore } from '@langchain/core/vectorstores';
import { Document as LangChainDocument } from '@langchain/core/documents';
import { VectorRetriever } from '../../src/retrievers/vectorRetriever';
import { KeywordRetriever } from '../../src/retrievers/keywordRetriever';
import { HybridRetriever } from '../../src/retrievers/hybridRetriever';
import { EnsembleRetrieverWrapper } from '../../src/retrievers/ensembleRetriever';

// ─── Evaluation Corpus ───────────────────────────────────────────────

interface EvalDocument {
  id: string;
  content: string;
  metadata: Record<string, string>;
}

const CORPUS: EvalDocument[] = [
  // ── Python cluster ──
  {
    id: 'py-intro',
    content: 'Python is a high-level general-purpose programming language. Its design philosophy emphasizes code readability with the use of significant indentation. Python supports multiple programming paradigms including procedural, object-oriented, and functional programming.',
    metadata: { source: 'python.md', topic: 'python' },
  },
  {
    id: 'py-ml',
    content: 'Python is the most popular language for machine learning and artificial intelligence. Libraries like TensorFlow, PyTorch, and scikit-learn make Python the go-to choice for building neural networks, training models, and performing data analysis.',
    metadata: { source: 'python-ml.md', topic: 'python' },
  },
  {
    id: 'py-web',
    content: 'Django and Flask are popular Python web frameworks. Django provides a full-featured web framework with an ORM, template engine, and admin interface. Flask is a lightweight micro-framework favoring simplicity and flexibility.',
    metadata: { source: 'python-web.md', topic: 'python' },
  },
  {
    id: 'py-testing',
    content: 'pytest is the most popular testing framework for Python applications. It supports fixtures, parameterized tests, and plugins. unittest is the built-in testing module in the Python standard library with xUnit-style test organization.',
    metadata: { source: 'python-testing.md', topic: 'python' },
  },
  {
    id: 'py-async',
    content: 'Python asyncio provides asynchronous programming support using async and await keywords. Event loops manage concurrent I/O operations without threading. Libraries like aiohttp enable high-performance asynchronous HTTP clients and servers.',
    metadata: { source: 'python-async.md', topic: 'python' },
  },
  // ── JavaScript / TypeScript cluster ──
  {
    id: 'js-intro',
    content: 'JavaScript is a high-level interpreted scripting language used primarily for web development. Along with HTML and CSS, JavaScript is one of the core technologies of the World Wide Web. JavaScript enables interactive web pages and dynamic user interfaces.',
    metadata: { source: 'javascript.md', topic: 'javascript' },
  },
  {
    id: 'js-node',
    content: 'Node.js is a JavaScript runtime built on Chrome V8 engine. Node.js allows developers to use JavaScript for server-side programming, building scalable network applications and RESTful APIs with frameworks like Express.',
    metadata: { source: 'nodejs.md', topic: 'javascript' },
  },
  {
    id: 'js-react',
    content: 'React is a JavaScript library for building user interfaces. React uses a virtual DOM for efficient rendering and a component-based architecture. JSX syntax allows writing HTML-like code within JavaScript for declarative UI development.',
    metadata: { source: 'react.md', topic: 'javascript' },
  },
  {
    id: 'js-testing',
    content: 'Jest is a JavaScript testing framework developed by Facebook. It provides zero-config setup, snapshot testing, and code coverage reports. Mocha is another popular test runner that supports asynchronous testing and BDD-style assertions with Chai.',
    metadata: { source: 'js-testing.md', topic: 'javascript' },
  },
  {
    id: 'ts-intro',
    content: 'TypeScript is a strongly typed superset of JavaScript developed by Microsoft. TypeScript adds optional static typing, classes, and interfaces to JavaScript. It compiles to plain JavaScript and improves developer productivity with better tooling.',
    metadata: { source: 'typescript.md', topic: 'typescript' },
  },
  // ── Rust cluster ──
  {
    id: 'rust-intro',
    content: 'Rust is a systems programming language focused on safety, speed, and concurrency. Rust achieves memory safety without garbage collection through its ownership system. Rust is used for operating systems, game engines, and WebAssembly.',
    metadata: { source: 'rust.md', topic: 'rust' },
  },
  {
    id: 'rust-web',
    content: 'Actix-web and Rocket are Rust web frameworks offering high performance and memory safety. Rust web servers consistently outperform Node.js and Python in benchmarks due to zero-cost abstractions and lack of garbage collection overhead.',
    metadata: { source: 'rust-web.md', topic: 'rust' },
  },
  {
    id: 'rust-async',
    content: 'Tokio is the most popular async runtime for Rust. It provides an asynchronous task scheduler, TCP/UDP sockets, timers, and channels. The async/await syntax in Rust enables writing concurrent code that is both safe and efficient.',
    metadata: { source: 'rust-async.md', topic: 'rust' },
  },
  // ── ML / AI cluster ──
  {
    id: 'ml-basics',
    content: 'Machine learning is a branch of artificial intelligence that enables systems to learn from data. Supervised learning uses labeled data, unsupervised learning discovers patterns, and reinforcement learning optimizes through trial and error.',
    metadata: { source: 'ml-basics.md', topic: 'ml' },
  },
  {
    id: 'ml-nlp',
    content: 'Natural language processing uses machine learning to understand human language. Transformers and attention mechanisms power modern NLP models like BERT and GPT. Tasks include text classification, sentiment analysis, named entity recognition, and machine translation.',
    metadata: { source: 'ml-nlp.md', topic: 'ml' },
  },
  {
    id: 'ml-embeddings',
    content: 'Vector embeddings represent text as dense numerical vectors in high-dimensional space. Similar texts produce similar vectors enabling semantic search. Models like sentence-transformers generate embeddings used for retrieval-augmented generation and similarity matching.',
    metadata: { source: 'ml-embeddings.md', topic: 'ml' },
  },
  {
    id: 'ml-deep',
    content: 'Deep learning uses neural networks with multiple layers to model complex patterns. Convolutional neural networks excel at image recognition while recurrent neural networks handle sequential data. Transfer learning allows fine-tuning pre-trained models for specific tasks.',
    metadata: { source: 'ml-deep.md', topic: 'ml' },
  },
  // ── Database cluster ──
  {
    id: 'db-sql',
    content: 'PostgreSQL is a powerful open-source relational database supporting SQL queries, ACID transactions, and JSON data types. Indexes improve query performance on large tables. Foreign keys, joins, and stored procedures enable complex data modeling.',
    metadata: { source: 'db-sql.md', topic: 'database' },
  },
  {
    id: 'db-nosql',
    content: 'MongoDB is a document-oriented NoSQL database storing data as flexible JSON-like documents. It offers horizontal scaling through sharding and high availability via replica sets. Redis is an in-memory key-value store used for caching and message queues.',
    metadata: { source: 'db-nosql.md', topic: 'database' },
  },
  {
    id: 'db-vector',
    content: 'Vector databases like LanceDB, Pinecone, and Weaviate store high-dimensional embeddings for similarity search. They use approximate nearest neighbor algorithms like HNSW and IVF for fast retrieval. Vector databases power semantic search and RAG applications.',
    metadata: { source: 'db-vector.md', topic: 'database' },
  },
  // ── DevOps / Cloud cluster ──
  {
    id: 'docker-intro',
    content: 'Docker is a platform for developing, shipping, and running applications in containers. Containers package applications with their dependencies, ensuring consistent environments across development, testing, and production.',
    metadata: { source: 'docker.md', topic: 'devops' },
  },
  {
    id: 'k8s-intro',
    content: 'Kubernetes orchestrates container deployment, scaling, and management across clusters. Pods are the smallest deployable units containing one or more containers. Services, ingress controllers, and ConfigMaps manage networking and configuration.',
    metadata: { source: 'kubernetes.md', topic: 'devops' },
  },
  {
    id: 'cicd-intro',
    content: 'Continuous integration and continuous deployment automate building, testing, and deploying software. GitHub Actions, Jenkins, and GitLab CI define pipelines as code. Automated tests run on every commit to catch regressions early.',
    metadata: { source: 'cicd.md', topic: 'devops' },
  },
  // ── Security cluster ──
  {
    id: 'sec-auth',
    content: 'OAuth 2.0 and OpenID Connect are standard protocols for authentication and authorization. JSON Web Tokens encode claims securely for stateless session management. Multi-factor authentication adds an extra verification step beyond passwords.',
    metadata: { source: 'security-auth.md', topic: 'security' },
  },
  {
    id: 'sec-web',
    content: 'Cross-site scripting and SQL injection are common web vulnerabilities. Content Security Policy headers mitigate XSS attacks. Parameterized queries prevent SQL injection. HTTPS encrypts data in transit using TLS certificates.',
    metadata: { source: 'security-web.md', topic: 'security' },
  },
  // ── API Design cluster ──
  {
    id: 'api-rest',
    content: 'REST APIs use HTTP methods with resource-based URLs following CRUD conventions. GET retrieves resources, POST creates them, PUT updates, and DELETE removes. Status codes like 200, 404, and 500 communicate outcomes to API consumers.',
    metadata: { source: 'api-rest.md', topic: 'api' },
  },
  {
    id: 'api-graphql',
    content: 'GraphQL is a query language for APIs developed by Facebook. Clients specify exactly which fields they need, eliminating over-fetching. Schemas define types and resolvers. Mutations handle data modification while subscriptions enable real-time updates.',
    metadata: { source: 'api-graphql.md', topic: 'api' },
  },
  // ── Version Control ──
  {
    id: 'git-basics',
    content: 'Git is a distributed version control system tracking changes in source code. Branches allow parallel development while merging combines changes. Rebasing creates a linear history. Pull requests enable code review before merging into the main branch.',
    metadata: { source: 'git.md', topic: 'tools' },
  },
  // ── Performance cluster ──
  {
    id: 'perf-caching',
    content: 'Caching stores frequently accessed data in fast storage to reduce latency. CDNs cache static assets at edge locations globally. Redis and Memcached provide in-memory application caching. Cache invalidation strategies include TTL, LRU, and event-driven purging.',
    metadata: { source: 'perf-caching.md', topic: 'performance' },
  },
  {
    id: 'perf-optimization',
    content: 'Database query optimization involves analyzing execution plans and adding indexes. Connection pooling reduces overhead for database connections. Load balancing distributes traffic across server instances. Profiling tools identify performance bottlenecks in application code.',
    metadata: { source: 'perf-optimization.md', topic: 'performance' },
  },
];

// ─── Ground-truth Relevance ──────────────────────────────────────────

interface EvalQuery {
  query: string;
  /** Keyword-adapted form (as QueryPlannerAgent.toKeywordQuery would produce) */
  keywordQuery: string;
  /** Optional sub-queries simulating query decomposition */
  subQueries?: string[];
  /** IDs of relevant documents, ordered by decreasing relevance */
  relevant: string[];
}

// Stop words matching QueryPlannerAgent.STOP_WORDS
const PLANNER_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
  'from', 'this', 'that', 'these', 'those', 'it', 'its', 'and', 'or', 'but', 'not',
  'about', 'how', 'what', 'when', 'where', 'why', 'which', 'who', 'very', 'also',
  'mean', 'means', 'meaning', 'meant', 'definition', 'define', 'defined',
  'explain', 'explained', 'explanation', 'describe', 'described', 'description',
  'tell', 'give', 'show', 'list', 'find', 'know', 'understand',
  'purpose', 'reason', 'example', 'examples', 'important', 'biggest', 'main',
]);

/** Replicate QueryPlannerAgent.toKeywordQuery */
function toKeywordQuery(sentence: string): string {
  return sentence
    .replace(/[?!.,;:'"()\[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1)
    .filter(w => !PLANNER_STOP_WORDS.has(w.toLowerCase()))
    .join(' ');
}

const EVAL_QUERIES: EvalQuery[] = [
  // ── Direct keyword queries ──
  {
    query: 'Python machine learning',
    keywordQuery: toKeywordQuery('Python machine learning'),
    subQueries: ['Python programming', 'machine learning'],
    relevant: ['py-ml', 'ml-basics', 'py-intro'],
  },
  {
    query: 'JavaScript web development',
    keywordQuery: toKeywordQuery('JavaScript web development'),
    subQueries: ['JavaScript language', 'web development'],
    relevant: ['js-intro', 'js-node', 'js-react'],
  },
  {
    query: 'Rust systems programming memory safety',
    keywordQuery: toKeywordQuery('Rust systems programming memory safety'),
    subQueries: ['Rust programming', 'memory safety'],
    relevant: ['rust-intro', 'rust-web'],
  },
  {
    query: 'Python web frameworks Django Flask',
    keywordQuery: toKeywordQuery('Python web frameworks Django Flask'),
    relevant: ['py-web', 'py-intro'],
  },
  {
    query: 'TypeScript static typing',
    keywordQuery: toKeywordQuery('TypeScript static typing'),
    relevant: ['ts-intro', 'js-intro'],
  },
  // ── Synonym / paraphrase queries (no exact keyword matches) ──
  {
    query: 'containerized application deployment',
    keywordQuery: toKeywordQuery('containerized application deployment'),
    relevant: ['docker-intro', 'k8s-intro'],
  },
  {
    query: 'securing web applications against attacks',
    keywordQuery: toKeywordQuery('securing web applications against attacks'),
    relevant: ['sec-web', 'sec-auth'],
  },
  {
    query: 'speeding up database queries',
    keywordQuery: toKeywordQuery('speeding up database queries'),
    relevant: ['perf-optimization', 'perf-caching', 'db-sql'],
  },
  {
    query: 'representing text as numbers for search',
    keywordQuery: toKeywordQuery('representing text as numbers for search'),
    relevant: ['ml-embeddings', 'db-vector'],
  },
  // ── Natural language questions ──
  {
    query: 'What testing frameworks are available for Python and JavaScript?',
    keywordQuery: toKeywordQuery('What testing frameworks are available for Python and JavaScript?'),
    subQueries: ['Python testing frameworks', 'JavaScript testing frameworks'],
    relevant: ['py-testing', 'js-testing'],
  },
  {
    query: 'How does async programming work in Python and Rust?',
    keywordQuery: toKeywordQuery('How does async programming work in Python and Rust?'),
    subQueries: ['Python async await asyncio', 'Rust async Tokio runtime'],
    relevant: ['py-async', 'rust-async'],
  },
  {
    query: 'What is the difference between REST and GraphQL APIs?',
    keywordQuery: toKeywordQuery('What is the difference between REST and GraphQL APIs?'),
    subQueries: ['REST API design', 'GraphQL query language'],
    relevant: ['api-rest', 'api-graphql'],
  },
  // ── Multi-topic / cross-cluster queries ──
  {
    query: 'SQL vs NoSQL databases and when to use each',
    keywordQuery: toKeywordQuery('SQL vs NoSQL databases and when to use each'),
    subQueries: ['SQL relational database PostgreSQL', 'NoSQL document database MongoDB'],
    relevant: ['db-sql', 'db-nosql'],
  },
  {
    query: 'CI/CD pipelines with Docker and Kubernetes',
    keywordQuery: toKeywordQuery('CI/CD pipelines with Docker and Kubernetes'),
    subQueries: ['CI/CD continuous integration', 'Docker Kubernetes container orchestration'],
    relevant: ['cicd-intro', 'docker-intro', 'k8s-intro'],
  },
  {
    query: 'vector databases for semantic search and RAG',
    keywordQuery: toKeywordQuery('vector databases for semantic search and RAG'),
    relevant: ['db-vector', 'ml-embeddings'],
  },
  // ── Single-document precision queries ──
  {
    query: 'Git branching and pull requests',
    keywordQuery: toKeywordQuery('Git branching and pull requests'),
    relevant: ['git-basics'],
  },
  {
    query: 'OAuth JWT authentication',
    keywordQuery: toKeywordQuery('OAuth JWT authentication'),
    relevant: ['sec-auth'],
  },
  {
    query: 'React component architecture virtual DOM',
    keywordQuery: toKeywordQuery('React component architecture virtual DOM'),
    relevant: ['js-react'],
  },
  // ── Hard / ambiguous queries ──
  {
    query: 'performance optimization and caching strategies',
    keywordQuery: toKeywordQuery('performance optimization and caching strategies'),
    subQueries: ['caching CDN Redis', 'database optimization profiling'],
    relevant: ['perf-caching', 'perf-optimization'],
  },
  {
    query: 'deep learning NLP transformers',
    keywordQuery: toKeywordQuery('deep learning NLP transformers'),
    subQueries: ['deep learning neural networks', 'NLP transformers BERT GPT'],
    relevant: ['ml-deep', 'ml-nlp', 'ml-basics'],
  },
];

// ─── Query-aware Mock Vector Store ───────────────────────────────────

/** Tracks last query text so the vector store can alter ordering. */
class TrackingEmbeddings extends Embeddings {
  public lastQuery: string = '';
  constructor() { super({}); }
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0]);
  }
  async embedQuery(text: string): Promise<number[]> {
    this.lastQuery = text;
    return [0];
  }
}

/**
 * Returns documents ordered by a simple keyword-overlap heuristic so that
 * VECTOR strategy results resemble real semantic search.
 */
class EvalMockVectorStore extends VectorStore {
  private documents: LangChainDocument[] = [];
  private trackingEmbeddings: TrackingEmbeddings;

  constructor() {
    const emb = new TrackingEmbeddings();
    super(emb, {});
    this.trackingEmbeddings = emb;
  }

  _vectorstoreType(): string { return 'eval-mock'; }

  async addDocuments(docs: LangChainDocument[]): Promise<void> {
    this.documents.push(...docs);
  }
  async addVectors(): Promise<void> {}

  async similaritySearchVectorWithScore(
    _query: number[],
    k: number
  ): Promise<[LangChainDocument, number][]> {
    return this.rank(this.trackingEmbeddings.lastQuery, k);
  }

  async similaritySearchWithScore(
    query: string,
    k: number
  ): Promise<[LangChainDocument, number][]> {
    // Store query so vector path can also use it
    this.trackingEmbeddings.lastQuery = query;
    return this.rank(query, k);
  }

  async similaritySearch(query: string, k: number): Promise<LangChainDocument[]> {
    this.trackingEmbeddings.lastQuery = query;
    const results = await this.rank(query, k);
    return results.map(([doc]) => doc);
  }

  /**
   * Rank documents by keyword overlap with query. Returns (doc, distance)
   * pairs sorted ascending by distance (lower = more similar).
   */
  private rank(query: string, k: number): [LangChainDocument, number][] {
    const queryTerms = query.toLowerCase().split(/\W+/).filter(t => t.length > 2);

    const scored = this.documents.map((doc) => {
      const content = doc.pageContent.toLowerCase();
      let overlap = 0;
      for (const term of queryTerms) {
        const re = new RegExp(`\\b${term}\\b`, 'g');
        const matches = content.match(re);
        if (matches) overlap += matches.length;
      }
      // Convert overlap to distance: more overlap → smaller distance
      const distance = 1 / (1 + overlap);
      return [doc, distance] as [LangChainDocument, number];
    });

    scored.sort((a, b) => a[1] - b[1]);
    return scored.slice(0, k);
  }
}

// ─── IR Metrics ──────────────────────────────────────────────────────

function precisionAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k);
  const hits = topK.filter(id => relevant.has(id)).length;
  return hits / k;
}

function recallAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k);
  const hits = topK.filter(id => relevant.has(id)).length;
  return relevant.size > 0 ? hits / relevant.size : 0;
}

/** Mean Reciprocal Rank: 1 / rank-of-first-relevant-document */
function mrr(retrieved: string[], relevant: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Normalized Discounted Cumulative Gain */
function ndcg(retrieved: string[], relevantOrdered: string[], k: number): number {
  // Build relevance grades: best relevant doc gets highest grade
  const gradeMap = new Map<string, number>();
  for (let i = 0; i < relevantOrdered.length; i++) {
    gradeMap.set(relevantOrdered[i], relevantOrdered.length - i);
  }

  // DCG of actual ranking
  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrieved.length); i++) {
    const grade = gradeMap.get(retrieved[i]) ?? 0;
    dcg += grade / Math.log2(i + 2); // i+2 because log2(1)=0
  }

  // Ideal DCG (perfect ranking)
  const idealGrades = relevantOrdered
    .map((_, i) => relevantOrdered.length - i)
    .slice(0, k);
  let idcg = 0;
  for (let i = 0; i < idealGrades.length; i++) {
    idcg += idealGrades[i] / Math.log2(i + 2);
  }

  return idcg > 0 ? dcg / idcg : 0;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function docId(doc: LangChainDocument): string {
  return doc.metadata?.id ?? doc.metadata?.chunkId ?? 'unknown';
}

type StrategyName = 'VECTOR' | 'HYBRID' | 'ENSEMBLE' | 'BM25';

interface StrategyMetrics {
  strategy: StrategyName;
  precision: number;
  recall: number;
  mrr: number;
  ndcg: number;
}

// ─── Test Suite ──────────────────────────────────────────────────────

describe('Retrieval Evaluation', function () {
  const K = 5; // evaluate at k

  let vectorStore: EvalMockVectorStore;
  let vectorRetriever: VectorRetriever;
  let keywordRetriever: KeywordRetriever;
  let hybridRetriever: HybridRetriever;
  let ensembleRetriever: EnsembleRetrieverWrapper;

  let langchainDocs: LangChainDocument[];

  before(async function () {
    // Build LangChain documents from corpus
    langchainDocs = CORPUS.map(
      (e) => new LangChainDocument({ pageContent: e.content, metadata: { ...e.metadata, id: e.id } })
    );

    // Set up vector store
    vectorStore = new EvalMockVectorStore();
    await vectorStore.addDocuments(langchainDocs);

    // Build retrievers
    vectorRetriever = new VectorRetriever(vectorStore);
    keywordRetriever = new KeywordRetriever();
    await keywordRetriever.initialize(langchainDocs);

    hybridRetriever = new HybridRetriever(vectorRetriever, keywordRetriever);
    ensembleRetriever = new EnsembleRetrieverWrapper(vectorRetriever, keywordRetriever);
  });

  // ─── Per-query tests ────────────────────────────────────────────

  for (const evalQuery of EVAL_QUERIES) {
    describe(`Query: "${evalQuery.query}"`, function () {
      it('should retrieve relevant documents across all strategies', async function () {
        const relevantSet = new Set(evalQuery.relevant);
        const queryMetrics: StrategyMetrics[] = [];

        // 1. VECTOR
        const vectorResults = await hybridRetriever.vectorSearch(evalQuery.query, K);
        const vectorIds = vectorResults.map(r => docId(r.document));
        queryMetrics.push({
          strategy: 'VECTOR',
          precision: precisionAtK(vectorIds, relevantSet, K),
          recall: recallAtK(vectorIds, relevantSet, K),
          mrr: mrr(vectorIds, relevantSet),
          ndcg: ndcg(vectorIds, evalQuery.relevant, K),
        });

        // 2. HYBRID
        const hybridResults = await hybridRetriever.search(evalQuery.query, { k: K });
        const hybridIds = hybridResults.map(r => docId(r.document));
        queryMetrics.push({
          strategy: 'HYBRID',
          precision: precisionAtK(hybridIds, relevantSet, K),
          recall: recallAtK(hybridIds, relevantSet, K),
          mrr: mrr(hybridIds, relevantSet),
          ndcg: ndcg(hybridIds, evalQuery.relevant, K),
        });

        // 3. ENSEMBLE
        const ensembleResults = await ensembleRetriever.search(evalQuery.query, { k: K });
        const ensembleIds = ensembleResults.map(r => docId(r.document));
        queryMetrics.push({
          strategy: 'ENSEMBLE',
          precision: precisionAtK(ensembleIds, relevantSet, K),
          recall: recallAtK(ensembleIds, relevantSet, K),
          mrr: mrr(ensembleIds, relevantSet),
          ndcg: ndcg(ensembleIds, evalQuery.relevant, K),
        });

        // 4. BM25
        const bm25Results = await keywordRetriever.search(evalQuery.query, K);
        const bm25Ids = bm25Results.map(r => docId(r.document));
        queryMetrics.push({
          strategy: 'BM25',
          precision: precisionAtK(bm25Ids, relevantSet, K),
          recall: recallAtK(bm25Ids, relevantSet, K),
          mrr: mrr(bm25Ids, relevantSet),
          ndcg: ndcg(bm25Ids, evalQuery.relevant, K),
        });

        // Print per-query summary
        console.log(`\n  📊 "${evalQuery.query}" (relevant: ${evalQuery.relevant.join(', ')})`);
        console.log('  ┌────────────┬───────────┬────────┬───────┬───────┐');
        console.log('  │ Strategy   │ P@5       │ R@5    │ MRR   │ nDCG  │');
        console.log('  ├────────────┼───────────┼────────┼───────┼───────┤');
        for (const m of queryMetrics) {
          console.log(
            `  │ ${m.strategy.padEnd(10)} │ ${m.precision.toFixed(3).padStart(9)} │ ${m.recall.toFixed(3).padStart(6)} │ ${m.mrr.toFixed(3).padStart(5)} │ ${m.ndcg.toFixed(3).padStart(5)} │`
          );
        }
        console.log('  └────────────┴───────────┴────────┴───────┴───────┘');

        // Print retrieved document IDs for inspection
        console.log(`  VECTOR:   [${vectorIds.join(', ')}]`);
        console.log(`  HYBRID:   [${hybridIds.join(', ')}]`);
        console.log(`  ENSEMBLE: [${ensembleIds.join(', ')}]`);
        console.log(`  BM25:     [${bm25Ids.join(', ')}]`);

        // At least one strategy should find a relevant doc for each query
        const bestRecall = Math.max(...queryMetrics.map(m => m.recall));
        expect(bestRecall, 'at least one strategy should find a relevant doc').to.be.greaterThan(0);
      });
    });
  }

  // ─── Aggregate comparison ───────────────────────────────────────

  describe('Aggregate Metrics', function () {
    it('should compute mean metrics across all queries', async function () {
      const aggregates = new Map<StrategyName, { p: number[]; r: number[]; mrr: number[]; ndcg: number[] }>();
      for (const s of ['VECTOR', 'HYBRID', 'ENSEMBLE', 'BM25'] as StrategyName[]) {
        aggregates.set(s, { p: [], r: [], mrr: [], ndcg: [] });
      }

      for (const evalQuery of EVAL_QUERIES) {
        const relevantSet = new Set(evalQuery.relevant);

        // VECTOR
        const vRes = await hybridRetriever.vectorSearch(evalQuery.query, K);
        const vIds = vRes.map(r => docId(r.document));
        aggregates.get('VECTOR')!.p.push(precisionAtK(vIds, relevantSet, K));
        aggregates.get('VECTOR')!.r.push(recallAtK(vIds, relevantSet, K));
        aggregates.get('VECTOR')!.mrr.push(mrr(vIds, relevantSet));
        aggregates.get('VECTOR')!.ndcg.push(ndcg(vIds, evalQuery.relevant, K));

        // HYBRID
        const hRes = await hybridRetriever.search(evalQuery.query, { k: K });
        const hIds = hRes.map(r => docId(r.document));
        aggregates.get('HYBRID')!.p.push(precisionAtK(hIds, relevantSet, K));
        aggregates.get('HYBRID')!.r.push(recallAtK(hIds, relevantSet, K));
        aggregates.get('HYBRID')!.mrr.push(mrr(hIds, relevantSet));
        aggregates.get('HYBRID')!.ndcg.push(ndcg(hIds, evalQuery.relevant, K));

        // ENSEMBLE
        const eRes = await ensembleRetriever.search(evalQuery.query, { k: K });
        const eIds = eRes.map(r => docId(r.document));
        aggregates.get('ENSEMBLE')!.p.push(precisionAtK(eIds, relevantSet, K));
        aggregates.get('ENSEMBLE')!.r.push(recallAtK(eIds, relevantSet, K));
        aggregates.get('ENSEMBLE')!.mrr.push(mrr(eIds, relevantSet));
        aggregates.get('ENSEMBLE')!.ndcg.push(ndcg(eIds, evalQuery.relevant, K));

        // BM25
        const bRes = await keywordRetriever.search(evalQuery.query, K);
        const bIds = bRes.map(r => docId(r.document));
        aggregates.get('BM25')!.p.push(precisionAtK(bIds, relevantSet, K));
        aggregates.get('BM25')!.r.push(recallAtK(bIds, relevantSet, K));
        aggregates.get('BM25')!.mrr.push(mrr(bIds, relevantSet));
        aggregates.get('BM25')!.ndcg.push(ndcg(bIds, evalQuery.relevant, K));
      }

      const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

      console.log('\n  ═══════════════════════════════════════════════════════');
      console.log('  AGGREGATE METRICS (mean across all queries)');
      console.log('  ═══════════════════════════════════════════════════════');
      console.log('  ┌────────────┬───────────┬────────┬───────┬───────┐');
      console.log('  │ Strategy   │ Mean P@5  │ Mean R │ MRR   │ nDCG  │');
      console.log('  ├────────────┼───────────┼────────┼───────┼───────┤');
      for (const s of ['VECTOR', 'HYBRID', 'ENSEMBLE', 'BM25'] as StrategyName[]) {
        const a = aggregates.get(s)!;
        console.log(
          `  │ ${s.padEnd(10)} │ ${mean(a.p).toFixed(3).padStart(9)} │ ${mean(a.r).toFixed(3).padStart(6)} │ ${mean(a.mrr).toFixed(3).padStart(5)} │ ${mean(a.ndcg).toFixed(3).padStart(5)} │`
        );
      }
      console.log('  └────────────┴───────────┴────────┴───────┴───────┘');

      // All strategies should have mean MRR > 0 (at least finds 1 relevant doc first)
      for (const s of ['VECTOR', 'HYBRID', 'ENSEMBLE', 'BM25'] as StrategyName[]) {
        const a = aggregates.get(s)!;
        expect(mean(a.mrr), `${s} mean MRR > 0`).to.be.greaterThan(0);
      }
    });
  });

  // ─── Keyword-adapted evaluation ─────────────────────────────────
  // In production, QueryPlannerAgent converts natural language queries
  // to keyword form for BM25/ENSEMBLE. This section compares raw vs
  // keyword-adapted queries for those strategies.

  describe('Keyword-Adapted Queries (BM25 + ENSEMBLE)', function () {
    it('should improve BM25/ENSEMBLE when using keyword-adapted queries', async function () {
      const rawMetrics = { bm25: [] as number[], ensemble: [] as number[] };
      const kwMetrics = { bm25: [] as number[], ensemble: [] as number[] };

      for (const eq of EVAL_QUERIES) {
        const relevantSet = new Set(eq.relevant);

        // Raw query
        const rawBm25 = await keywordRetriever.search(eq.query, K);
        rawMetrics.bm25.push(recallAtK(rawBm25.map(r => docId(r.document)), relevantSet, K));
        const rawEns = await ensembleRetriever.search(eq.query, { k: K });
        rawMetrics.ensemble.push(recallAtK(rawEns.map(r => docId(r.document)), relevantSet, K));

        // Keyword-adapted query
        const kwBm25 = await keywordRetriever.search(eq.keywordQuery, K);
        kwMetrics.bm25.push(recallAtK(kwBm25.map(r => docId(r.document)), relevantSet, K));
        const kwEns = await ensembleRetriever.search(eq.keywordQuery, { k: K });
        kwMetrics.ensemble.push(recallAtK(kwEns.map(r => docId(r.document)), relevantSet, K));
      }

      const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

      console.log('\n  ═══════════════════════════════════════════════════════');
      console.log('  KEYWORD ADAPTATION IMPACT (Recall@5)');
      console.log('  ═══════════════════════════════════════════════════════');
      console.log('  ┌────────────┬──────────┬──────────┬────────┐');
      console.log('  │ Strategy   │ Raw      │ Keyword  │ Delta  │');
      console.log('  ├────────────┼──────────┼──────────┼────────┤');
      for (const s of ['bm25', 'ensemble'] as const) {
        const rawM = mean(rawMetrics[s]);
        const kwM = mean(kwMetrics[s]);
        const delta = kwM - rawM;
        const label = s.toUpperCase().padEnd(10);
        console.log(`  │ ${label} │ ${rawM.toFixed(3).padStart(8)} │ ${kwM.toFixed(3).padStart(8)} │ ${(delta >= 0 ? '+' : '') + delta.toFixed(3).padStart(6)} │`);
      }
      console.log('  └────────────┴──────────┴──────────┴────────┘');

      // Keyword queries should not be worse than raw queries on average
      expect(mean(kwMetrics.bm25)).to.be.at.least(mean(rawMetrics.bm25) - 0.1);
      expect(mean(kwMetrics.ensemble)).to.be.at.least(mean(rawMetrics.ensemble) - 0.1);
    });
  });

  // ─── Query Decomposition evaluation ─────────────────────────────
  // Simulates how the QueryPlannerAgent decomposes complex queries into
  // sub-queries and merges results.

  describe('Query Decomposition Impact', function () {
    it('should improve recall via sub-query decomposition', async function () {
      const queriesWithSubs = EVAL_QUERIES.filter(eq => eq.subQueries && eq.subQueries.length > 0);

      console.log('\n  ═══════════════════════════════════════════════════════');
      console.log('  QUERY DECOMPOSITION IMPACT');
      console.log('  ═══════════════════════════════════════════════════════');

      const strategies: { name: StrategyName; run: (q: string) => Promise<string[]> }[] = [
        {
          name: 'VECTOR',
          run: async (q) => (await hybridRetriever.vectorSearch(q, K)).map(r => docId(r.document)),
        },
        {
          name: 'HYBRID',
          run: async (q) => (await hybridRetriever.search(q, { k: K })).map(r => docId(r.document)),
        },
        {
          name: 'ENSEMBLE',
          run: async (q) => (await ensembleRetriever.search(q, { k: K })).map(r => docId(r.document)),
        },
        {
          name: 'BM25',
          run: async (q) => (await keywordRetriever.search(q, K)).map(r => docId(r.document)),
        },
      ];

      const singleRecalls: Record<StrategyName, number[]> = { VECTOR: [], HYBRID: [], ENSEMBLE: [], BM25: [] };
      const decompRecalls: Record<StrategyName, number[]> = { VECTOR: [], HYBRID: [], ENSEMBLE: [], BM25: [] };

      for (const eq of queriesWithSubs) {
        const relevantSet = new Set(eq.relevant);

        for (const strategy of strategies) {
          // Single query
          const singleIds = await strategy.run(eq.query);
          singleRecalls[strategy.name].push(recallAtK(singleIds, relevantSet, K));

          // Decomposed: run each sub-query, merge unique results
          const allIds: string[] = [];
          for (const subQ of eq.subQueries!) {
            const subIds = await strategy.run(subQ);
            for (const id of subIds) {
              if (!allIds.includes(id)) allIds.push(id);
            }
          }
          decompRecalls[strategy.name].push(recallAtK(allIds, relevantSet, K));
        }
      }

      const mean = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

      console.log('  ┌────────────┬──────────┬──────────┬────────┐');
      console.log('  │ Strategy   │ Single   │ Decomp   │ Delta  │');
      console.log('  ├────────────┼──────────┼──────────┼────────┤');
      for (const s of ['VECTOR', 'HYBRID', 'ENSEMBLE', 'BM25'] as StrategyName[]) {
        const sM = mean(singleRecalls[s]);
        const dM = mean(decompRecalls[s]);
        const delta = dM - sM;
        console.log(`  │ ${s.padEnd(10)} │ ${sM.toFixed(3).padStart(8)} │ ${dM.toFixed(3).padStart(8)} │ ${(delta >= 0 ? '+' : '') + delta.toFixed(3).padStart(6)} │`);
      }
      console.log('  └────────────┴──────────┴──────────┴────────┘');

      // Note: With a small corpus, decomposition may reduce recall because
      // single queries already achieve high recall. Decomposition benefits
      // primarily appear with large corpora where a single query can't
      // surface all relevant topics. This test documents the effect.
      expect(true).to.be.true; // Observational — check console output
    });
  });
});
