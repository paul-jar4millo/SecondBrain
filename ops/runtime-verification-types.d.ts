import type {
  ConversationReceipt,
  ConversationState,
} from "../lanzador/provider-conversation-types.mjs";
import type {
  LauncherSession,
  SessionState,
} from "../lanzador/session-types.d.ts";
import type {
  CatalogState,
  SkillProvenanceStage,
} from "../lanzador/tool-catalog-types.d.ts";
import type { UserRequest } from "../service/user-request-types.d.ts";
import type { Artifact, WorkEvent } from "../service/work-order-types.d.ts";

export type RuntimeTurn = Omit<Partial<LauncherSession>, "estado"> & {
  estado: SessionState | "omitida_skills_only";
};

export type RuntimeConversationSnapshot = Partial<
  Pick<ConversationState, "seq" | "requests" | "events">
> & { tools?: { nombre: string; estado: string }[] };

export type RuntimeProductQuestion = Pick<
  UserRequest,
  "id" | "kind" | "allowFreeText" | "status"
> & {
  response?: { freeText?: string | null } | null;
  receipt?: { freeText?: string | null } | null;
};

export type RuntimeWorkOrderDetail = {
  snapshot: { artifacts: Pick<Artifact, "id" | "fileRef" | "version">[] };
  events: Pick<WorkEvent, "type">[];
};

type CatalogStates = Partial<Record<CatalogState, boolean>>;

export type RuntimeCatalog = {
  connectors?: { id: string; states?: CatalogStates }[];
};

export interface ProductQuestionAnswer extends Pick<
  RuntimeProductQuestion,
  "id" | "kind" | "allowFreeText"
> {
  httpStatus: number;
  statusAfterAnswer: string | null;
}

interface ReportedTurn {
  estado: RuntimeTurn["estado"];
  elapsedMs: number;
}

export interface RuntimeVerificationReport {
  executedAt: string;
  commit: string;
  models: { agyCount: number; hasGemini38FlashMedium: boolean } | null;
  workOrderId: string | null;
  turn1:
    | (ReportedTurn & {
        sessionId?: string;
        error: string | null;
        conversacionId: string | null;
        conexion: LauncherSession["conexion"] | null;
        hasCanary: boolean;
        receivedExactFreeText: boolean;
      })
    | { skipped: true }
    | null;
  nativeApprovals: {
    requestId: string;
    httpStatus: number;
    deliveryStatus: ConversationReceipt["status"] | null;
    delivered: boolean | null;
  }[];
  productQuestion: ProductQuestionAnswer | null;
  turn2SamePid:
    | (ReportedTurn & {
        pidBefore: number | null;
        pidAfter: number | null;
        samePid: boolean;
        sameNativeSession: boolean;
        recalledFreeText: boolean;
      })
    | null;
  turn3Interrupt:
    (ReportedTurn & { cancelStatus: number; samePid: boolean }) | null;
  turn4Resume:
    (ReportedTurn & { reusedSamePid: boolean; hasMarker: boolean }) | null;
  artifactsApi: {
    totalArtifacts: number;
    samePathVersions: number;
    publishedEvents: number;
    downloads: {
      artifactId: string;
      version: number;
      httpStatus: number;
      headerSha256: string | null;
      computedSha256: string | null;
      bytesLength: number;
      hasCanary: boolean;
      hasFreeText: boolean;
      hasV2Line: boolean;
    }[];
  } | null;
  reloadPersistence: {
    questionStatus: string | null;
    questionAnswerText: boolean;
  } | null;
  coldResume: {
    httpStatus: number;
    estado: RuntimeTurn["estado"] | null;
    newPid: number | null;
    pidChanged: boolean;
    hasMarker: boolean;
    recalledCanary: boolean;
  } | null;
  shutdown: {
    httpStatus: number;
    closed: boolean;
    finalConexion: LauncherSession["conexion"] | null;
  } | null;
  sseUpdates: number;
  lastSeq: number | null;
  errors: string[];
  skillsLive?: {
    catalogSecondbrainProbed: boolean;
    catalogSecondbrainStates: CatalogStates | null;
    sessionId: string;
    estado: SessionState;
    error: string | null;
    pid: number | null;
    nativeSessionId: string | null;
    model: string;
    toolProfileId: string | null;
    skillIds: string[];
    expectedSha256: string;
    observedCommandsCount: number;
    observedPersonalContext: boolean;
    conversationHasSkillsEvent: boolean;
    provenanceStages: {
      skillId: string;
      stage: SkillProvenanceStage;
      sha256: string | null;
      source: string | null;
    }[];
    toolsObserved: NonNullable<RuntimeConversationSnapshot["tools"]>;
    resultPreview: string;
    canaryFound: boolean;
    tokenFileCleaned: boolean;
  };
}
