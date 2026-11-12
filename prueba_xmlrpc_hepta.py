#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prueba de hepta_find_or_create por XML-RPC, como lo va a llamar HEPTA Cloud.

A diferencia de la bateria que corre en `odoo shell`, esta prueba ejercita el
camino real: red, autenticacion con API key (obligatoria con 2FA activo),
permisos del usuario de integracion y serializacion XML-RPC.

IMPORTANTE: esto SI escribe en la base. Apuntar a heptagroup_test.

Uso:
    ODOO_URL=http://127.0.0.1:8070 \
    ODOO_DB=heptagroup_test \
    ODOO_USER=apihepta \
    ODOO_KEY=<la api key> \
    python3 prueba_xmlrpc_hepta.py

Desde el servidor de Odoo se prueba con 127.0.0.1:8070 (auth y permisos).
Desde el servidor de HEPTA Cloud, con http://10.10.20.234:8070 (ademas, la red).
"""
import os
import sys
import uuid
import xmlrpc.client

URL = os.environ.get('ODOO_URL', 'http://127.0.0.1:8070').rstrip('/')
DB = os.environ.get('ODOO_DB', 'heptagroup_test')
USER = os.environ.get('ODOO_USER', 'apihepta')
KEY = os.environ.get('ODOO_KEY', '')

if not KEY:
    sys.exit("Falta ODOO_KEY (la API key del usuario de integracion).")
if 'heptagroup_test' not in DB:
    respuesta = input("La base %r no parece la de pruebas. Escribi 'si' para seguir: " % DB)
    if respuesta.strip().lower() != 'si':
        sys.exit("Cancelado.")

print("Servidor : %s" % URL)
print("Base     : %s" % DB)
print("Usuario  : %s\n" % USER)

common = xmlrpc.client.ServerProxy('%s/xmlrpc/2/common' % URL)
print("1. Version del servidor")
info = common.version()
print("   %s (protocolo %s)\n" % (info.get('server_version'), info.get('protocol_version')))

print("2. Autenticacion con API key")
uid = common.authenticate(DB, USER, KEY, {})
if not uid:
    sys.exit("   FALLA: authenticate devolvio False.\n"
             "   Con 2FA activo la contrasena NO sirve: hay que usar una API key\n"
             "   (Preferencias del usuario -> Seguridad de la cuenta -> Claves API).")
print("   OK: uid = %s\n" % uid)

models = xmlrpc.client.ServerProxy('%s/xmlrpc/2/object' % URL)


def call(metodo, args, kwargs=None):
    return models.execute_kw(DB, uid, KEY, 'res.partner', metodo, args, kwargs or {})


print("3. Permiso de lectura sobre res.partner")
print("   contactos visibles: %s\n" % call('search_count', [[]]))

cliente = str(uuid.uuid4())
payload = {
    'hepta_client_id': cliente,
    'tipo_doc': 'ruc',
    'numero_doc': '80099887',
    'dv': '4',
    'tipo_persona': 'juridica',
    'razon_social': 'PRUEBA XMLRPC S.A.',
    'nombre_comercial': 'PruebaRPC',
    'email': 'xmlrpc@prueba.py',
    'telefono': '595981123456',
    'direccion': 'Ruta 2 km 15',
    'ciudad': 'Asuncion',
    'departamento': 'Central',
    'unidad': 'hepta_cloud',
}

print("4. hepta_find_or_create (alta)")
alta = call('hepta_find_or_create', [payload])
print("   %s" % alta)
if alta.get('estado') != 'ok' or not alta.get('creado'):
    print("   ATENCION: se esperaba un alta nueva. Si el documento ya existia en la base,")
    print("   revisa el motivo antes de sacar conclusiones.\n")
else:
    print("   OK: partner %s creado\n" % alta['partner_id'])

print("5. Idempotencia (la misma llamada otra vez)")
repetida = call('hepta_find_or_create', [payload])
print("   %s" % repetida)
print("   %s\n" % ("OK: mismo partner, no duplica"
                   if repetida.get('partner_id') == alta.get('partner_id')
                   and not repetida.get('creado')
                   else "FALLA: no es idempotente"))

print("6. hepta_get_partner (lectura para el portal)")
print("   %s\n" % call('hepta_get_partner', [cliente]))

print("7. Caso sin documento (debe ir a la cola, no crear)")
sin_doc = call('hepta_find_or_create', [{
    'hepta_client_id': str(uuid.uuid4()),
    'razon_social': 'Sin Doc XMLRPC', 'unidad': 'retopa'}])
print("   %s" % sin_doc)
print("   %s\n" % ("OK" if sin_doc.get('motivo') == 'sin_documento' else "FALLA"))

print("=" * 60)
print("Los registros de esta corrida QUEDAN en %s." % DB)
if alta.get('partner_id'):
    print("Partner creado: id %s  (archivar, no borrar)" % alta['partner_id'])
print("hepta_client_id de prueba: %s" % cliente)
