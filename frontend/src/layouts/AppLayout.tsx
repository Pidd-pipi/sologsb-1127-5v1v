import { useEffect } from 'react';
import { Layout, Menu, Space, Tag, Typography } from 'antd';
import {
  HomeOutlined,
  PlusCircleOutlined,
  EnvironmentOutlined,
  NodeIndexOutlined,
  ToolOutlined,
  DatabaseOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore } from '../stores/routeStore';
import { useHandoverStore } from '../stores/handoverStore';

const { Sider, Content, Header } = Layout;

const MENU = [
  { key: '/', icon: <HomeOutlined />, label: '核验总览' },
  { key: '/points/new', icon: <PlusCircleOutlined />, label: '点位登记' },
  { key: '/routes', icon: <NodeIndexOutlined />, label: '通行路线' },
  { key: '/map', icon: <EnvironmentOutlined />, label: '设施地图' },
  { key: '/rectify', icon: <ToolOutlined />, label: '整改清单' },
  { key: '/handover', icon: <SwapOutlined />, label: '离线交接' },
];

export default function AppLayout() {
  const location = useLocation();
  const loadPoints = usePointStore((s) => s.load);
  const loadRoutes = useRouteStore((s) => s.load);
  const pointCount = usePointStore((s) => s.points.length);
  const inspectionCount = usePointStore((s) => s.inspections.length);
  const points = usePointStore((s) => s.points);
  const inspections = usePointStore((s) => s.inspections);
  const rectifies = usePointStore((s) => s.rectifies);
  const online = useHandoverStore((s) => s.online);
  const dirtyCount = useHandoverStore((s) => s.dirtyCount);
  const pendingConflicts = useHandoverStore(
    (s) => s.conflicts.filter((c) => c.status === 'pending').length,
  );
  const hasKey = Boolean((import.meta.env.VITE_AMAP_KEY || '').trim());

  useEffect(() => {
    void loadPoints().then(() => {
      // 启动时若在线，先把本机改动并进服务端并拉回合并结果
      void useHandoverStore.getState().syncNow();
    });
    void loadRoutes();
  }, [loadPoints, loadRoutes]);

  // 网络恢复后自动同步；断网时改动继续留在本机
  useEffect(() => {
    const handleOnline = () => {
      useHandoverStore.getState().setOnline(true);
      void useHandoverStore.getState().syncNow();
    };
    const handleOffline = () => useHandoverStore.getState().setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // 本机业务数据变化后刷新「待同步」计数
  useEffect(() => {
    void useHandoverStore.getState().refreshDirtyCount();
  }, [points, inspections, rectifies]);

  const selectedKey =
    MENU.map((m) => m.key)
      .filter((k) => k !== '/' && location.pathname.startsWith(k))
      .sort((a, b) => b.length - a.length)[0] || '/';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={216} theme="dark" breakpoint="lg" collapsedWidth={64}>
        <div className="gb-logo">
          <DatabaseOutlined style={{ fontSize: 20 }} />
          <div>
            <div className="gb-logo-title">无障碍设施核验</div>
            <div className="gb-logo-sub">gbaccessmap</div>
          </div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={MENU.map((m) => ({
            key: m.key,
            icon: m.icon,
            label: <Link to={m.key}>{m.label}</Link>,
          }))}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #eef1f5',
          }}
        >
          <Typography.Title level={5} style={{ margin: 0 }}>
            城市无障碍设施核验地图
          </Typography.Title>
          <Space size={8}>
            <Tag color={online ? 'green' : 'orange'} data-testid="net-tag">
              {online ? '在线' : '离线'}
            </Tag>
            <Tag color={dirtyCount ? 'gold' : 'default'} data-testid="dirty-tag">
              待同步 {dirtyCount}
            </Tag>
            {pendingConflicts ? (
              <Tag color="red" data-testid="conflict-tag">
                待裁决 {pendingConflicts}
              </Tag>
            ) : null}
            <Tag color="blue" data-testid="count-points">
              点位 {pointCount}
            </Tag>
            <Tag color="cyan" data-testid="count-inspections">
              核验 {inspectionCount}
            </Tag>
            <Tag color={hasKey ? 'green' : 'orange'} data-testid="amap-key-tag">
              {hasKey ? '高德地图已配置' : '网格降级模式'}
            </Tag>
          </Space>
        </Header>
        <Content>
          <div className="gb-content">
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
