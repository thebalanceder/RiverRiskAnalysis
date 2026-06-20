"""
River Detective - Mini Program (微信小程序模拟)
Usage: python river_detective_miniapp.py
"""
import requests
import json

API = "http://localhost:8000"


def print_banner():
    print("""
    ╔══════════════════════════════════════════╗
    ║        🕵️  RIVER DETECTIVE  🕵️          ║
    ║     "Main Pasal Sungai, Macam Detektif"  ║
    ╚══════════════════════════════════════════╝
    """)


def menu():
    print("\n[1] Lihat Status Sungai (Sensor)")
    print("[2] Laporkan Pencemaran (Citizen Report)")
    print("[3] Papan Pemimpin (Leaderboard)")
    print("[4] Profil Saya")
    print("[5] Tebus Pokok Bakau (IMELC)")
    print("[0] Keluar")
    return input("\nPilihan: ")


def simulate_detection():
    print("\n--- Memeriksa Sensor Sungai ---")
    readings = [
        {"sensor_id": "SG-01 Hulu", "ph": 6.8, "turbidity": 8,
         "timestamp": "2026-06-03T10:00:00"},
        {"sensor_id": "SG-02 Tengah", "ph": 7.0, "turbidity": 10,
         "timestamp": "2026-06-03T10:00:00"},
        {"sensor_id": "SG-03 Hilir", "ph": 7.1, "turbidity": 7,
         "timestamp": "2026-06-03T10:00:00"},
        {"sensor_id": "SG-04 Industri", "ph": 4.1, "turbidity": 92,
         "timestamp": "2026-06-03T10:00:00"},
        {"sensor_id": "SG-05 Residen", "ph": 5.0, "turbidity": 71,
         "timestamp": "2026-06-03T10:00:00"},
        {"sensor_id": "SG-06 Komersial", "ph": 6.9, "turbidity": 12,
         "timestamp": "2026-06-03T10:00:00"},
        {"sensor_id": "SG-07 Pertanian", "ph": 7.0, "turbidity": 9,
         "timestamp": "2026-06-03T10:00:00"},
        {"sensor_id": "SG-08 Muara", "ph": 6.8, "turbidity": 15,
         "timestamp": "2026-06-03T10:00:00"},
        {"sensor_id": "SG-09 Bandar", "ph": 6.7, "turbidity": 11,
         "timestamp": "2026-06-03T10:00:00"},
        {"sensor_id": "SG-10 Estet", "ph": 7.2, "turbidity": 13,
         "timestamp": "2026-06-03T10:00:00"},
    ]
    try:
        r = requests.post(f"{API}/detect", json=readings, timeout=5)
        data = r.json()
        if data["status"] == "alert":
            print("\n🚨 PENCEMARAN DIKESAN! 🚨")
            print(f"  Tahap: {data['analysis']['severity'].upper()}")
            for s in data['analysis']['anomaly_sensors']:
                print(f"  ⚠️  {s['sensor']}: pH={s['ph']}, Kekeruhan={s['turbidity']} NTU")
            print(f"\n🔍 Punca dianggarkan: {data['trace']['upstream_epicenter']}")
            print(f"📏 Jarak dari hulu: {data['trace']['estimated_distance_from_head_m']:.0f}m")
            print(f"🎯 Keyakinan: {data['trace']['confidence']:.0f}%")
            # Enrichment from ALL integrated data
            e = data.get('enrichment', {})
            if e:
                pc = e.get('pollution_class', {})
                print(f"\n📊 KLASIFIKASI PENCEMARAN:")
                print(f"   Zon: {pc.get('dominant_zone')}")
                print(f"   Sebab: {pc.get('likely_cause','')[:60]}")
                suspects = e.get('suspects', [])
                if suspects:
                    print(f"🔧 PAIP DISYAKI ({len(suspects)}):")
                    for s in suspects[:3]:
                        print(f"   • {s.get('type')} ({s.get('distance_m',0):.0f}m)")
                enf = e.get('enforcement', {})
                print(f"\n👮 PENGUATKUASAAN:")
                print(f"   Balai: {enf.get('police_station','Tiada')}")
                print(f"   IPD: {enf.get('ipd','Tiada')}")
                imp = e.get('impact', {})
                if imp.get('estimated_population'):
                    print(f"👥 Populasi terjejas: ~{imp['estimated_population']}")
                cc = imp.get('community_center', {})
                if cc.get('name'):
                    print(f"🏫 Pusat komuniti: {cc['name']}")
                imelc = e.get('imelc_recommendation', {})
                print(f"\n🌱 IMELC: {imelc.get('priority','Tiada')}")
                if imelc.get('recommended_species'):
                    print(f"   Spesies: {', '.join(imelc['recommended_species'])}")
        else:
            print("\n✅ Air dalam keadaan selamat.")
    except Exception as e:
        print(f"Ralat: {e}")


def submit_report(user_id):
    print("\n--- Lapor Pencemaran ---")
    desc = input("Huraian (contoh: Air hijau berbuih): ")
    data = {"user_id": user_id, "photo_description": desc}
    try:
        r = requests.post(f"{API}/report", json=data, timeout=5)
        d = r.json()
        print(f"\n✅ Laporan diterima!")
        print(f"   Mata Ekologi: +{d['points_earned']}")
        print(f"   Total: {d['total_points']}")
        if d['badges_earned']:
            for b in d['badges_earned']:
                print(f"   🏅 Badge Baru: {b['name']} - {b['desc']}")
        if d['mangrove_trees_available'] > 0:
            print(f"   🌳 Pokok Bakau boleh ditebus: {d['mangrove_trees_available']}")
        imelc = d.get('imelc_recommendation', {})
        if imelc:
            print(f"\n🌱 IMELC ({imelc.get('priority','?')}): {', '.join(imelc.get('recommended_species',[]))}")
    except Exception as e:
        print(f"Ralat: {e}")


def show_leaderboard():
    try:
        r = requests.get(f"{API}/leaderboard", timeout=5)
        data = r.json()
        print("\n--- Papan Pemimpin 🏆 ---")
        for u in data["leaderboard"]:
            badges_str = " ".join([f"🏅{b}" for b in u["badges"]])
            print(f"  #{u['rank']} {u['user_id']} - {u['points']} pts ({u['reports']} laporan) {badges_str}")
    except Exception as e:
        print(f"Ralat: {e}")


def show_profile(user_id):
    try:
        r = requests.get(f"{API}/user/{user_id}", timeout=5)
        d = r.json()
        print(f"\n--- Profil: {d['user_id']} ---")
        print(f"  Mata Ekologi: {d['points']}")
        print(f"  Jumlah Laporan: {d['total_reports']}")
        print(f"  Streak: {d['streak']} hari")
        print(f"  Pokok Bakau: {d['mangrove_trees']} 🌳")
        if d['badges']:
            print(f"  Badges:")
            for b in d['badges']:
                print(f"    🏅 {b['name']}: {b['desc']}")
        if d['recent_reports']:
            print(f"  Laporan Terkini:")
            for rpt in d['recent_reports'][-3:]:
                print(f"    • {rpt['description'][:40]}... ({rpt['severity']}) +{rpt['points_earned']}pts")
    except Exception as e:
        print(f"Ralat: {e}")


def redeem_mangrove(user_id):
    try:
        r = requests.get(f"{API}/user/{user_id}", timeout=5)
        d = r.json()
        if d['mangrove_trees'] > 0:
            print(f"\n🌳 Anda boleh tebus {d['mangrove_trees']} pokok bakau!")
            confirm = input("Tebus sekarang? (y/n): ")
            if confirm.lower() == 'y':
                print(f"✅ {d['mangrove_trees']} pokok bakau telah ditanam melalui IMELC! 🌱")
        else:
            print("\n❌ Mata tidak cukup. Perlu 200 mata untuk 1 pokok bakau.")
            print(f"   Mata semasa: {d['points']}/200")
    except Exception as e:
        print(f"Ralat: {e}")


if __name__ == "__main__":
    print_banner()
    user_id = input("Nama pengguna: ")
    while True:
        p = menu()
        if p == "1":
            simulate_detection()
        elif p == "2":
            submit_report(user_id)
        elif p == "3":
            show_leaderboard()
        elif p == "4":
            show_profile(user_id)
        elif p == "5":
            redeem_mangrove(user_id)
        elif p == "0":
            print("Jaga sungai kita! 🌊")
            break
