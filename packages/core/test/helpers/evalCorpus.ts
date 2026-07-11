/**
 * Shared evaluation corpus used by retrievalBenchmark and retrievalEvaluation tests.
 * 30 documents across 10 topic clusters with graded relevance judgments.
 */

export interface EvalDocument {
  id: string;
  content: string;
  metadata: Record<string, string>;
}

export const EVAL_CORPUS: EvalDocument[] = [
  // ── Python cluster ──
  {
    id: "py-intro",
    content:
      "Python is a high-level general-purpose programming language. Its design philosophy emphasizes code readability with the use of significant indentation. Python supports multiple programming paradigms including procedural, object-oriented, and functional programming.",
    metadata: { source: "python.md", topic: "python" },
  },
  {
    id: "py-ml",
    content:
      "Python is the most popular language for machine learning and artificial intelligence. Libraries like TensorFlow, PyTorch, and scikit-learn make Python the go-to choice for building neural networks, training models, and performing data analysis.",
    metadata: { source: "python-ml.md", topic: "python" },
  },
  {
    id: "py-web",
    content:
      "Django and Flask are popular Python web frameworks. Django provides a full-featured web framework with an ORM, template engine, and admin interface. Flask is a lightweight micro-framework favoring simplicity and flexibility.",
    metadata: { source: "python-web.md", topic: "python" },
  },
  {
    id: "py-testing",
    content:
      "pytest is the most popular testing framework for Python applications. It supports fixtures, parameterized tests, and plugins. unittest is the built-in testing module in the Python standard library with xUnit-style test organization.",
    metadata: { source: "python-testing.md", topic: "python" },
  },
  {
    id: "py-async",
    content:
      "Python asyncio provides asynchronous programming support using async and await keywords. Event loops manage concurrent I/O operations without threading. Libraries like aiohttp enable high-performance asynchronous HTTP clients and servers.",
    metadata: { source: "python-async.md", topic: "python" },
  },
  // ── JavaScript / TypeScript cluster ──
  {
    id: "js-intro",
    content:
      "JavaScript is a high-level interpreted scripting language used primarily for web development. Along with HTML and CSS, JavaScript is one of the core technologies of the World Wide Web. JavaScript enables interactive web pages and dynamic user interfaces.",
    metadata: { source: "javascript.md", topic: "javascript" },
  },
  {
    id: "js-node",
    content:
      "Node.js is a JavaScript runtime built on Chrome V8 engine. Node.js allows developers to use JavaScript for server-side programming, building scalable network applications and RESTful APIs with frameworks like Express.",
    metadata: { source: "nodejs.md", topic: "javascript" },
  },
  {
    id: "js-react",
    content:
      "React is a JavaScript library for building user interfaces. React uses a virtual DOM for efficient rendering and a component-based architecture. JSX syntax allows writing HTML-like code within JavaScript for declarative UI development.",
    metadata: { source: "react.md", topic: "javascript" },
  },
  {
    id: "js-testing",
    content:
      "Jest is a JavaScript testing framework developed by Facebook. It provides zero-config setup, snapshot testing, and code coverage reports. Mocha is another popular test runner that supports asynchronous testing and BDD-style assertions with Chai.",
    metadata: { source: "js-testing.md", topic: "javascript" },
  },
  {
    id: "ts-intro",
    content:
      "TypeScript is a strongly typed superset of JavaScript developed by Microsoft. TypeScript adds optional static typing, classes, and interfaces to JavaScript. It compiles to plain JavaScript and improves developer productivity with better tooling.",
    metadata: { source: "typescript.md", topic: "typescript" },
  },
  // ── Rust cluster ──
  {
    id: "rust-intro",
    content:
      "Rust is a systems programming language focused on safety, speed, and concurrency. Rust achieves memory safety without garbage collection through its ownership system. Rust is used for operating systems, game engines, and WebAssembly.",
    metadata: { source: "rust.md", topic: "rust" },
  },
  {
    id: "rust-web",
    content:
      "Actix-web and Rocket are Rust web frameworks offering high performance and memory safety. Rust web servers consistently outperform Node.js and Python in benchmarks due to zero-cost abstractions and lack of garbage collection overhead.",
    metadata: { source: "rust-web.md", topic: "rust" },
  },
  {
    id: "rust-async",
    content:
      "Tokio is the most popular async runtime for Rust. It provides an asynchronous task scheduler, TCP/UDP sockets, timers, and channels. The async/await syntax in Rust enables writing concurrent code that is both safe and efficient.",
    metadata: { source: "rust-async.md", topic: "rust" },
  },
  // ── ML / AI cluster ──
  {
    id: "ml-basics",
    content:
      "Machine learning is a branch of artificial intelligence that enables systems to learn from data. Supervised learning uses labeled data, unsupervised learning discovers patterns, and reinforcement learning optimizes through trial and error.",
    metadata: { source: "ml-basics.md", topic: "ml" },
  },
  {
    id: "ml-nlp",
    content:
      "Natural language processing uses machine learning to understand human language. Transformers and attention mechanisms power modern NLP models like BERT and GPT. Tasks include text classification, sentiment analysis, named entity recognition, and machine translation.",
    metadata: { source: "ml-nlp.md", topic: "ml" },
  },
  {
    id: "ml-embeddings",
    content:
      "Vector embeddings represent text as dense numerical vectors in high-dimensional space. Similar texts produce similar vectors enabling semantic search. Models like sentence-transformers generate embeddings used for retrieval-augmented generation and similarity matching.",
    metadata: { source: "ml-embeddings.md", topic: "ml" },
  },
  {
    id: "ml-deep",
    content:
      "Deep learning uses neural networks with multiple layers to model complex patterns. Convolutional neural networks excel at image recognition while recurrent neural networks handle sequential data. Transfer learning allows fine-tuning pre-trained models for specific tasks.",
    metadata: { source: "ml-deep.md", topic: "ml" },
  },
  // ── Database cluster ──
  {
    id: "db-sql",
    content:
      "PostgreSQL is a powerful open-source relational database supporting SQL queries, ACID transactions, and JSON data types. Indexes improve query performance on large tables. Foreign keys, joins, and stored procedures enable complex data modeling.",
    metadata: { source: "db-sql.md", topic: "database" },
  },
  {
    id: "db-nosql",
    content:
      "MongoDB is a document-oriented NoSQL database storing data as flexible JSON-like documents. It offers horizontal scaling through sharding and high availability via replica sets. Redis is an in-memory key-value store used for caching and message queues.",
    metadata: { source: "db-nosql.md", topic: "database" },
  },
  {
    id: "db-vector",
    content:
      "Vector databases like LanceDB, Pinecone, and Weaviate store high-dimensional embeddings for similarity search. They use approximate nearest neighbor algorithms like HNSW and IVF for fast retrieval. Vector databases power semantic search and RAG applications.",
    metadata: { source: "db-vector.md", topic: "database" },
  },
  // ── DevOps / Cloud cluster ──
  {
    id: "docker-intro",
    content:
      "Docker is a platform for developing, shipping, and running applications in containers. Containers package applications with their dependencies, ensuring consistent environments across development, testing, and production.",
    metadata: { source: "docker.md", topic: "devops" },
  },
  {
    id: "k8s-intro",
    content:
      "Kubernetes orchestrates container deployment, scaling, and management across clusters. Pods are the smallest deployable units containing one or more containers. Services, ingress controllers, and ConfigMaps manage networking and configuration.",
    metadata: { source: "kubernetes.md", topic: "devops" },
  },
  {
    id: "cicd-intro",
    content:
      "Continuous integration and continuous deployment automate building, testing, and deploying software. GitHub Actions, Jenkins, and GitLab CI define pipelines as code. Automated tests run on every commit to catch regressions early.",
    metadata: { source: "cicd.md", topic: "devops" },
  },
  // ── Security cluster ──
  {
    id: "sec-auth",
    content:
      "OAuth 2.0 and OpenID Connect are standard protocols for authentication and authorization. JSON Web Tokens encode claims securely for stateless session management. Multi-factor authentication adds an extra verification step beyond passwords.",
    metadata: { source: "security-auth.md", topic: "security" },
  },
  {
    id: "sec-web",
    content:
      "Cross-site scripting and SQL injection are common web vulnerabilities. Content Security Policy headers mitigate XSS attacks. Parameterized queries prevent SQL injection. HTTPS encrypts data in transit using TLS certificates.",
    metadata: { source: "security-web.md", topic: "security" },
  },
  // ── API Design cluster ──
  {
    id: "api-rest",
    content:
      "REST APIs use HTTP methods with resource-based URLs following CRUD conventions. GET retrieves resources, POST creates them, PUT updates, and DELETE removes. Status codes like 200, 404, and 500 communicate outcomes to API consumers.",
    metadata: { source: "api-rest.md", topic: "api" },
  },
  {
    id: "api-graphql",
    content:
      "GraphQL is a query language for APIs developed by Facebook. Clients specify exactly which fields they need, eliminating over-fetching. Schemas define types and resolvers. Mutations handle data modification while subscriptions enable real-time updates.",
    metadata: { source: "api-graphql.md", topic: "api" },
  },
  // ── Version Control ──
  {
    id: "git-basics",
    content:
      "Git is a distributed version control system tracking changes in source code. Branches allow parallel development while merging combines changes. Rebasing creates a linear history. Pull requests enable code review before merging into the main branch.",
    metadata: { source: "git.md", topic: "tools" },
  },
  // ── Performance cluster ──
  {
    id: "perf-caching",
    content:
      "Caching stores frequently accessed data in fast storage to reduce latency. CDNs cache static assets at edge locations globally. Redis and Memcached provide in-memory application caching. Cache invalidation strategies include TTL, LRU, and event-driven purging.",
    metadata: { source: "perf-caching.md", topic: "performance" },
  },
  {
    id: "perf-optimization",
    content:
      "Database query optimization involves analyzing execution plans and adding indexes. Connection pooling reduces overhead for database connections. Load balancing distributes traffic across server instances. Profiling tools identify performance bottlenecks in application code.",
    metadata: { source: "perf-optimization.md", topic: "performance" },
  },
];
