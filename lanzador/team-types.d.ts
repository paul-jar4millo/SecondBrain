export interface ManifestCardInput {
  id?: string;
  characterId?: string | null;
  motor?: string;
  engine?: string;
  model?: string;
  effort?: string | null;
  role?: string;
  responsibility?: string;
  coordinator?: boolean;
  toolProfileId?: string;
  assigned?: boolean;
}

export interface ManifestInput {
  manifestVersion?: number;
  workOrderId?: string | null;
  teamRevision?: number;
  coordinatorId?: string | null;
  team: ManifestCardInput[];
  sha256?: string;
}

export type ManifestCard = Required<ManifestCardInput>;

export interface TeamManifest extends Required<ManifestInput> {
  team: ManifestCard[];
}

export interface MemberUpdate {
  workspacePath?: string | null;
  workspaceKind?: string | null;
  modelo?: string | null;
  esfuerzo?: string | null;
  toolProfileId?: string | null;
  role?: string | null;
  responsibility?: string | null;
  estado?: string | null;
}

export interface TeamMetadata extends Omit<MemberUpdate, "estado"> {
  motor?: string;
  memberId?: string | null;
  requestId?: string | null;
  workOrderId?: string | null;
  manifest?: ManifestInput | null;
  manifestSha256?: string | null;
  directorioIntegracion?: string | null;
}

export interface TeamMember extends MemberUpdate {
  id: string;
  padreId: string | null;
  profundidad: number;
  motor?: string;
  memberId?: string;
  requestId?: string;
  workOrderId?: string;
  manifestSha256?: string;
}

export interface TeamMessage {
  id: string;
  de: string;
  para: string;
  texto: string;
  fecha: string;
}

export interface DeliveryFileInput {
  ruta: string;
  contenido: string;
  baseSha256?: string | null;
}

export interface DeliveryInput {
  titulo: string;
  contenido?: string | null;
  ruta?: string | null;
  baseSha256?: string | null;
  archivos?: DeliveryFileInput[];
}

export interface TeamDelivery extends DeliveryInput {
  id: string;
  de: string;
  memberId?: string;
  role?: string;
  contenido: string;
  sha256?: string;
  version?: number;
  archivos?: (DeliveryFileInput & { sha256: string })[];
  fecha: string;
}

export interface IntegrationResolution {
  ruta: string;
  entregableId?: string;
  contenido?: string;
}

export interface IntegrationOptions {
  entregableIds?: string[] | null;
  targetDir?: string | null;
  resoluciones?: IntegrationResolution[];
}

export interface IntegrationCandidate extends DeliveryFileInput {
  entregableId: string;
  de: string;
  memberId: string | null;
  role: string | null;
  sha256: string;
  baseSha256: string | null;
  version: number;
  fecha: string;
}

export interface ApprovedCandidate extends IntegrationCandidate {
  resueltoExplicitamente?: boolean;
  discoEsperado: string | null;
}

export interface IntegrationConflict {
  ruta: string;
  motivo: string;
  hashIntegradoActual: string | null;
  hashEnDisco: string | null;
  entregas: Omit<IntegrationCandidate, "ruta" | "contenido">[];
}

export interface IntegratedFile {
  ruta: string;
  sha256: string;
  baseSha256: string | null;
  version: number;
  fuenteEntregableId: string;
  miembro: string;
  resueltoExplicitamente?: boolean;
  hashEnDiscoReemplazado?: string | null;
  destino?: string;
}

export interface TextDeliverySummary {
  entregableId: string;
  de: string;
  memberId: string | null;
  titulo: string;
  sha256: string;
  version: number;
}

export interface IntegrationRecord {
  id: string;
  fecha: string;
  autor: string;
  workOrderId?: string;
  estado: "integrado";
  archivos: IntegratedFile[];
  entregables?: TextDeliverySummary[];
}

export type IntegrationResult =
  | {
      ok: false;
      estado: "conflicto";
      conflictos: IntegrationConflict[];
      integrados: [];
    }
  | {
      ok: true;
      estado: "integrado";
      integracion: IntegrationRecord;
      integrados: IntegratedFile[];
      conflictos: [];
    };

export interface Team {
  id: string;
  lider: string;
  miembros: TeamMember[];
  mensajes: TeamMessage[];
  entregables: TeamDelivery[];
  workOrderId?: string;
  manifest?: TeamManifest;
  manifestSha256?: string;
  directorioIntegracion?: string;
  integraciones?: IntegrationRecord[];
  conflictos?: {
    id: string;
    fecha: string;
    autor: string;
    conflictos: IntegrationConflict[];
  }[];
}
