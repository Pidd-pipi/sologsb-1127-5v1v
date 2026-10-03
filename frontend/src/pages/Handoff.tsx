import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudSyncOutlined,
  LockOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import { useSyncStore } from '../sync/syncStore';
import { db } from '../db';
import { resolveConflictLocal } from '../sync/engine';
import { fieldLabel, formatConflictValue, kindLabel } from '../sync/labels';
import { usePointStore } from '../stores/pointStore';
import type { FieldConflict } from '../types/sync';
import { AREAS as FALLBACK_AREAS } from '../types/areas';

type ResolveChoice = 'local' | 'remote' | 'custom';

export default function Handoff() {
  const { message } = App.useApp();
  const sync = useSyncStore();
  const reloadPoints = usePointStore((s) => s.reload);
  const [conflicts, setConflicts] = useState<FieldConflict[]>([]);
  const [loadingConflicts, setLoadingConflicts] = useState(false);
  const [resolving, setResolving] = useState<FieldConflict | null>(null);
  const [choice, setChoice] = useState<ResolveChoice>('local');
  const [customValue, setCustomValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const refreshConflicts = async () => {
    setLoadingConflicts(true);
    const rows = await db.conflicts.toArray();
    setConflicts(
      rows
        .filter((c) => c.status === 'pending')
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    );
    setLoadingConflicts(false);
  };

  useEffect(() => {
    void sync.init();
    void refreshConflicts();
    const timer = setInterval(refreshConflicts, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const areas = sync.meta.areas.length
    ? sync.meta.areas
    : FALLBACK_AREAS.map((a) => ({ code: a.code, name: a.name, district: a.district }));

  const myId = sync.identity?.supervisorId;

  const handleSelectIdentity = async (value: string) => {
    const sup = sync.meta.supervisors.find((s) => s.id === value);
    if (!sup) return;
    await sync.selectIdentity(sup.id, sup.name);
    message.success(`当前身份：${sup.name}`);
  };

  const handleClaim = async (areaCode: string) => {
    if (!sync.identity) {
      message.warning('请先选择督导员身份');
      return;
    }
    const res = await sync.claim(areaCode);
    if (!res) {
      message.error('当前断网，无法领取片区（现场改动仍可保存在本机）');
      return;
    }
    if (res.status === 'holder') message.success('领取成功，你是该片区接管人');
    else
      message.info(
        `该片区已有接管人：${res.view.holder?.supervisorName ?? '未知'}，你已排第 ${res.view.queuePosition ?? 1} 位`,
      );
  };

  const handleSync = async () => {
    const r = await sync.syncNow();
    await reloadPoints();
    await refreshConflicts();
    if (!sync.identity) return;
    if (r.online) {
      message.success(`同步完成：推送 ${r.pushed} 条本机改动，待裁决冲突 ${r.conflicts} 个`);
    } else {
      message.warning('仍处断网状态，改动已保存在本机，恢复后自动合并');
    }
  };

  const openResolve = (c: FieldConflict) => {
    setResolving(c);
    setChoice('local');
    setCustomValue(formatConflictValue(c.localValue));
  };

  const handleResolve = async () => {
    if (!resolving) return;
    let value: unknown = customValue;
    if (choice === 'local') value = resolving.localValue;
    if (choice === 'remote') value = resolving.remoteValue;
    setSubmitting(true);
    try {
      const { online } = await resolveConflictLocal(resolving, value);
      await sync.conflictsChanged();
      await reloadPoints();
      await refreshConflicts();
      if (online) message.success('已裁决并同步到总库，该点位恢复进入总览与地图');
      else message.success('裁决已暂存本机，网络恢复后上报；裁决前该点位仍保持屏蔽');
      setResolving(null);
    } catch (e) {
      message.error(`裁决失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const conflictColumns: ColumnsType<FieldConflict> = [
    {
      title: '点位编号',
      dataIndex: 'pointCode',
      width: 140,
      render: (code: string) => <Tag color="blue">{code || '—'}</Tag>,
    },
    { title: '点位', dataIndex: 'entityName', width: 160, ellipsis: true },
    {
      title: '记录类型',
      dataIndex: 'kind',
      width: 100,
      render: (k: string) => kindLabel(k),
    },
    {
      title: '冲突字段',
      dataIndex: 'field',
      width: 120,
      render: (f: string) => <Typography.Text strong>{fieldLabel(f)}</Typography.Text>,
    },
    {
      title: '现场值（本次提交）',
      width: 200,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Tag color="green">{formatConflictValue(r.localValue)}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.localSource.supervisorName} · {r.localSource.at.slice(0, 19).replace('T', ' ')}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '总库值（另一方）',
      width: 200,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Tag color="orange">{formatConflictValue(r.remoteValue)}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.remoteSource.supervisorName} · {r.remoteSource.at.slice(0, 19).replace('T', ' ')}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 110,
      fixed: 'right',
      render: (_, r) => (
        <Button type="primary" size="small" onClick={() => openResolve(r)} data-testid={`resolve-${r.id}`}>
          裁决
        </Button>
      ),
    },
  ];

  const areaCards = useMemo(
    () =>
      areas.map((area) => {
        const state = sync.areas[area.code];
        const mine = sync.myClaims[area.code];
        const holder = state?.holder ?? null;
        const queue = state?.queue ?? [];
        const iAmHolder = holder?.supervisorId === myId;
        const iAmQueued = mine?.status === 'queued' && !iAmHolder;
        return (
          <Col xs={24} md={12} xl={8} key={area.code}>
            <Card
              size="small"
              data-testid={`area-${area.code}`}
              title={
                <Space size={6} wrap>
                  <LockOutlined />
                  <span>{area.name}</span>
                  <Tag>{area.code}</Tag>
                </Space>
              }
              extra={<Tag>{area.district}</Tag>}
            >
              {holder ? (
                <Descriptions column={1} size="small" colon={false}>
                  <Descriptions.Item label="当前接管人">
                    <Space>
                      <Badge status="processing" text={holder.supervisorName} />
                      {iAmHolder ? <Tag color="blue">我在核验</Tag> : null}
                    </Space>
                  </Descriptions.Item>
                  <Descriptions.Item label="排队">
                    {queue.length ? (
                      <Space wrap>
                        {queue.map((q) => (
                          <Tag key={q.supervisorId} color={iAmQueued && q.supervisorId === myId ? 'gold' : 'default'}>
                            {q.supervisorName}
                            {iAmQueued && q.supervisorId === myId
                              ? `（我，第 ${mine?.queuePosition ?? '?'} 位）`
                              : ''}
                          </Tag>
                        ))}
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">无人排队</Typography.Text>
                    )}
                  </Descriptions.Item>
                </Descriptions>
              ) : (
                <Typography.Text type="secondary">片区空闲，可立即领取进楼核验</Typography.Text>
              )}

              <Space style={{ marginTop: 10 }}>
                {iAmHolder ? (
                  <Button danger size="small" onClick={() => sync.release(area.code)} data-testid={`release-${area.code}`}>
                    释放接管（队首自动接管）
                  </Button>
                ) : iAmQueued ? (
                  <Button danger size="small" onClick={() => sync.release(area.code)}>
                    退出排队
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    size="small"
                    disabled={!sync.identity}
                    onClick={() => handleClaim(area.code)}
                    data-testid={`claim-${area.code}`}
                  >
                    {holder ? '排队领取' : '领取片区'}
                  </Button>
                )}
              </Space>
            </Card>
          </Col>
        );
      }),
    [areas, sync.areas, sync.myClaims, sync.identity],
  );

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">现场交接</h1>
          <Typography.Text type="secondary">
            分组进楼前领取片区（同一区域并发领取仅一人成功，其余排队可见接管人）；现场断网改动保存在本机，
            恢复后按点位编号合并，同字段两边都改则双留标源、待裁决。
          </Typography.Text>
        </div>
      </div>

      {!sync.identity ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="请先选择督导员身份"
          description="领取片区、提交改动与裁决冲突都需要署名，字段来源会记录到每一次改动。"
        />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <Card size="small" title={<Space><UserSwitchOutlined />督导员身份</Space>} data-testid="identity-card">
            <Select
              style={{ width: '100%' }}
              placeholder="选择你的身份"
              value={sync.identity?.supervisorId}
              onChange={handleSelectIdentity}
              options={(sync.meta.supervisors.length
                ? sync.meta.supervisors
                : [
                    { id: 'sup-liwei', name: '督导员 李维' },
                    { id: 'sup-wanglan', name: '督导员 王岚' },
                    { id: 'sup-chenmo', name: '督导员 陈默' },
                  ]
              ).map((s) => ({ value: s.id, label: s.name }))}
            />
            {sync.identity ? (
              <div style={{ marginTop: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  本机 clientId：{sync.clientId || '生成中…'}
                </Typography.Text>
              </div>
            ) : null}
          </Card>
        </Col>
        <Col xs={24} md={5}>
          <Card size="small" title="网络状态">
            <Tag color={sync.online ? 'green' : 'red'} data-testid="net-tag" style={{ fontSize: 14, padding: '4px 10px' }}>
              {sync.phase === 'syncing' ? '同步中…' : sync.online ? '在线' : '断网（本机保存）'}
            </Tag>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {sync.online ? '可领取片区 / 自动合并' : '改动仅写本机 IndexedDB'}
              </Typography.Text>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={5}>
          <Card size="small">
            <Statistic title="待提交本机改动" value={sync.outboxCount} suffix="条" data-testid="outbox-count" />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small">
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Button
                type="primary"
                icon={<CloudSyncOutlined />}
                loading={sync.phase === 'syncing'}
                disabled={!sync.identity}
                onClick={handleSync}
                block
                data-testid="sync-now"
              >
                立即合并/同步
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {sync.lastSyncAt ? `上次同步 ${sync.lastSyncAt.slice(0, 19).replace('T', ' ')}` : '尚未同步'}
                {sync.serverRev ? ` · 总库版本 ${sync.serverRev}` : ''}
              </Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>

      {!sync.online ? (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message="现场断网中：核验与整改结果继续保存在本机，不会丢失；网络恢复后自动（或点上方按钮）按点位编号合并。"
        />
      ) : null}

      <Typography.Title level={5} style={{ marginTop: 20 }}>
        片区领取与排队
      </Typography.Title>
      <Row gutter={[16, 16]}>{areaCards}</Row>

      <Card
        size="small"
        style={{ marginTop: 20 }}
        title={
          <Space>
            <span>待裁决字段冲突</span>
            <Badge count={conflicts.length} showZero data-testid="conflict-count" />
          </Space>
        }
      >
        {loadingConflicts ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : conflicts.length ? (
          <Table<FieldConflict>
            rowKey="id"
            size="small"
            scroll={{ x: 1100 }}
            pagination={{ pageSize: 5, hideOnSinglePage: true }}
            dataSource={conflicts}
            columns={conflictColumns}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="没有待裁决冲突：两边改动已自动合并，或冲突均已裁决"
          />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          裁决规则：同一字段两边都改过且值不一致时，两份值都会保留并标注督导员与时间；未裁决前该点位不进入总览与地图。
        </Typography.Text>
      </Card>

      <Modal
        open={!!resolving}
        title={resolving ? `裁决：${resolving.entityName} · ${fieldLabel(resolving.field)}` : ''}
        onCancel={() => setResolving(null)}
        onOk={handleResolve}
        confirmLoading={submitting}
        okText="确认裁决"
        cancelText="取消"
        data-testid="resolve-modal"
      >
        {resolving ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Radio.Group
              value={choice}
              onChange={(e) => setChoice(e.target.value as ResolveChoice)}
              data-testid="resolve-choice"
            >
              <Space direction="vertical">
                <Radio value="local">
                  采用现场值：<Tag color="green">{formatConflictValue(resolving.localValue)}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {resolving.localSource.supervisorName}
                  </Typography.Text>
                </Radio>
                <Radio value="remote">
                  采用总库值：<Tag color="orange">{formatConflictValue(resolving.remoteValue)}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {resolving.remoteSource.supervisorName}
                  </Typography.Text>
                </Radio>
                <Radio value="custom">手工填写裁决值</Radio>
              </Space>
            </Radio.Group>
            {choice === 'custom' ? (
              <Input
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                placeholder="输入最终采用的值"
                data-testid="resolve-custom"
              />
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
